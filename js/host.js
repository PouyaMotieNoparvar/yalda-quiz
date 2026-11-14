/* ============ Yalda Night Quiz — presenter ============ */
(function () {
  "use strict";
  const Y = window.Yalda;
  const $ = (s) => document.querySelector(s);
  const SAVE_KEY = "yalda_host_game_v1";
  const PREF_KEY = "yalda_host_prefs_v1";
  const Q_KEY = "yalda_custom_questions_v1";
  const GRACE_MS = 1500; // network grace after the timer hits zero

  const prefs = Object.assign({ broker: 0, seconds: 10 }, Y.store.get(PREF_KEY, {}));
  // one-time switch of any previously saved 30 s setting to the new 10 s default
  if (!prefs.t10) { prefs.seconds = 10; prefs.t10 = true; Y.store.set(PREF_KEY, prefs); }
  const builtIn = Y.decodeQuiz(window.QUIZ_DATA);
  let questions = Y.store.get(Q_KEY) || builtIn;

  /** The whole game lives here and is saved after every change, so a page reload can resume. */
  let G = null;
  let net = null;
  let tickTimer = null, clockTimer = null;

  function freshGame() {
    return {
      room: Y.rid(5, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"),
      broker: prefs.broker,
      seconds: prefs.seconds,
      questions,
      phase: "welcome",      // welcome | lobby | question | reveal | final
      qi: -1,
      qStart: 0, qEnd: 0,
      players: {},           // id -> { name, joined, answers: { [qi]: { c, t, p } } }
      order: [],
      finalStage: 0,
      created: Date.now(),
    };
  }
  const save = () => Y.store.set(SAVE_KEY, G);

  /* ---------------- scoring & ranking ---------------- */
  const totalOf = (p) => Object.values(p.answers).reduce((s, a) => s + a.p, 0);
  const correctOf = (p, qs = G.questions) => Object.entries(p.answers).filter(([qi, a]) => a.c === qs[qi].a).length;
  const correctTimeOf = (p) => Object.entries(p.answers).filter(([qi, a]) => a.c === G.questions[qi].a).reduce((s, [, a]) => s + a.t, 0);

  function ranking() {
    const rows = G.order.map((id) => {
      const p = G.players[id];
      return { id, name: p.name, total: totalOf(p), correct: correctOf(p), ctime: correctTimeOf(p), answered: Object.keys(p.answers).length };
    });
    rows.sort((a, b) => b.total - a.total || a.ctime - b.ctime || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].total === r.total && rows[i - 1].ctime === r.ctime ? rows[i - 1].rank : i + 1; });
    return rows;
  }
  function pointsFor(choice, qi, t) {
    if (choice !== G.questions[qi].a) return 0;
    const frac = Math.max(0, 1 - t / (G.seconds * 1000));
    return Math.round(500 + 500 * frac); // 500..1000, faster = more
  }

  /* ---------------- networking ---------------- */
  function connect() {
    if (net) try { net.client.end(true); } catch {}
    net = Y.connect(G.broker, (s, t) => Y.setStatus($("#status"), s, `${t} · ${Y.BROKERS[G.broker].name}`));
    net.client.on("connect", () => publishState());
    net.sub(Y.topic(G.room, "join"), onJoin);
    net.sub(Y.topic(G.room, "ans"), onAnswer);
  }
  const pub = (sub, obj, opts) => net && net.pub(Y.topic(G.room, sub), obj, opts);

  function onJoin(m) {
    if (!m || typeof m.id !== "string" || m.id.length > 40) return;
    let name = String(m.name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!name) return;
    let p = G.players[m.id];
    if (!p) {
      // make duplicate names distinguishable on the leaderboard
      const taken = new Set(Object.values(G.players).map((x) => x.name.toLowerCase()));
      if (taken.has(name.toLowerCase())) { let k = 2; while (taken.has(`${name} (${k})`.toLowerCase())) k++; name = `${name} (${k})`; }
      p = G.players[m.id] = { name, joined: Date.now(), answers: {} };
      G.order.push(m.id);
      save();
      renderLobbyNames(m.id);
      updateAnsweredCount();
    }
    pub(`ack/${m.id}`, { t: "join", name: p.name }, { qos: 1 });
    // a re-joining phone needs the current state; it's retained, but refresh it for safety
    publishState();
  }

  function onAnswer(m) {
    if (!m || G.phase !== "question" || m.qi !== G.qi) return;
    const p = G.players[m.id];
    if (!p) return;
    const now = Date.now();
    if (p.answers[G.qi]) { pub(`ack/${m.id}`, { t: "ans", qi: G.qi, c: p.answers[G.qi].c }); return; }
    if (now > G.qEnd + GRACE_MS) return;
    const c = m.c | 0;
    if (c < 0 || c >= G.questions[G.qi].o.length) return;
    const t = Math.min(now - G.qStart, G.seconds * 1000);
    p.answers[G.qi] = { c, t, p: pointsFor(c, G.qi, t) };
    save();
    pub(`ack/${m.id}`, { t: "ans", qi: G.qi, c });
    updateAnsweredCount();
  }

  function publishState() {
    if (!net) return;
    const q = G.questions[G.qi];
    const base = { room: G.room, n: G.order.length, total: G.questions.length, now: Date.now() };
    let s;
    if (G.phase === "welcome" || G.phase === "lobby") s = { ...base, ph: "lobby" };
    else if (G.phase === "question") s = { ...base, ph: "q", qi: G.qi, q: q.q, o: q.o, endsAt: G.qEnd, secs: G.seconds };
    else if (G.phase === "reveal") {
      const res = {};
      for (const r of ranking()) {
        const a = G.players[r.id].answers[G.qi];
        res[r.id] = [a ? a.p : 0, r.total, r.rank, a ? a.c : -1];
      }
      s = { ...base, ph: "r", qi: G.qi, q: q.q, o: q.o, a: q.a, counts: optionCounts(G.qi), res };
    } else if (G.phase === "final") {
      const rk = ranking();
      const res = {};
      for (const r of rk) res[r.id] = [r.total, r.rank, r.correct];
      s = { ...base, ph: "f", res, top: rk.slice(0, 3).map((r) => [r.name, r.total]) };
    }
    pub("state", s, { retain: true });
  }

  /* ---------------- screens ---------------- */
  function show(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === id));
    document.body.dataset.screen = id;
    document.body.classList.toggle("on-welcome", id === "s-welcome");
  }

  function joinURL() {
    const u = new URL("index.html", location.href);
    u.search = `?r=${G.room}` + (G.broker ? `&b=${G.broker}` : "");
    u.hash = "";
    return u.toString();
  }

  function renderLobby() {
    const url = joinURL();
    $("#qr").innerHTML = "";
    new QRCode($("#qr"), { text: url, width: 512, height: 512, colorDark: "#1a0710", colorLight: "#fff4e0", correctLevel: QRCode.CorrectLevel.M });
    $("#join-url").textContent = url.replace(/^https?:\/\//, "").replace(/index\.html\?r=.*$/, "");
    $("#room-code").textContent = G.room;
    $("#q-total").textContent = G.questions.length;
    $("#q-time").textContent = G.seconds;
    renderLobbyNames();
  }
  function renderLobbyNames(newId) {
    $("#player-count").textContent = G.order.length;
    const box = $("#names");
    if (!G.order.length) { box.innerHTML = '<div class="empty muted">Waiting for the first guest… ❄</div>'; return; }
    if (newId && box.querySelector(".name-pill")) {
      const el = document.createElement("span");
      el.className = "name-pill";
      el.textContent = G.players[newId].name;
      box.appendChild(el);
    } else {
      box.innerHTML = G.order.map((id, i) => `<span class="name-pill" style="animation-delay:${Math.min(i, 30) * 30}ms">${Y.esc(G.players[id].name)}</span>`).join("");
    }
    // keep the newest names visible if the box overflows
    while (box.scrollHeight > box.clientHeight + 4 && box.children.length > 1) box.removeChild(box.firstChild);
  }

  function goWelcome() { G.phase = "welcome"; save(); show("s-welcome"); publishState(); }
  function goLobby() { G.phase = "lobby"; save(); renderLobby(); show("s-lobby"); publishState(); }

  function startQuestion(i) {
    G.qi = i;
    G.phase = "question";
    G.qStart = Date.now() + 400;
    G.qEnd = G.qStart + G.seconds * 1000;
    save();
    renderQuestion();
    publishState();
    startTicking();
  }

  function renderSeeds() {
    $("#seeds").innerHTML = G.questions.map((_, i) => `<span class="seed ${i < G.qi || (i === G.qi && G.phase !== "question") ? "done" : i === G.qi ? "now" : ""}"></span>`).join("");
  }

  function renderQuestion() {
    const q = G.questions[G.qi];
    show("s-question");
    $("#q-num").textContent = `Question ${G.qi + 1} / ${G.questions.length}`;
    renderSeeds();
    const qt = $("#q-text");
    qt.textContent = q.q;
    qt.style.animation = "none"; void qt.offsetWidth; qt.style.animation = "";
    $("#opts").hidden = false;
    $("#chart-area").hidden = true;
    $("#opts").innerHTML = q.o.map((o, i) =>
      `<div class="opt" style="--c:var(--opt-${i % 4});animation-delay:${150 + i * 110}ms"><span class="glyph">${Y.OPTION_ICONS[i]}</span><span>${Y.esc(o)}</span></div>`).join("");
    $("#timer").hidden = false;
    $("#btn-end").hidden = false;
    $("#btn-next").hidden = true;
    updateAnsweredCount();
    updateTimer();
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(() => {
      updateTimer();
      if (Date.now() >= G.qEnd) endQuestion();
    }, 200);
    const clk = () => pub("clock", { now: Date.now(), endsAt: G.qEnd, qi: G.qi }, { qos: 0 });
    clk();
    clockTimer = setInterval(clk, 2000);
  }
  function stopTicking() { clearInterval(tickTimer); clearInterval(clockTimer); tickTimer = clockTimer = null; }

  function updateTimer() {
    const total = G.seconds * 1000;
    const left = Math.max(0, Math.min(total, G.qEnd - Date.now()));
    $("#timer-num").textContent = Math.ceil(left / 1000);
    $("#ring").style.strokeDashoffset = String(276.46 * (1 - left / total));
    $("#timer").classList.toggle("low", left <= 5000 && left > 0);
  }

  function updateAnsweredCount() {
    if (G.qi < 0) return;
    const n = G.order.filter((id) => G.players[id].answers[G.qi]).length;
    $("#answered").textContent = n;
    $("#answered-of").textContent = G.order.length;
  }

  function optionCounts(qi) {
    const counts = G.questions[qi].o.map(() => 0);
    for (const id of G.order) { const a = G.players[id].answers[qi]; if (a) counts[a.c]++; }
    return counts;
  }

  function endQuestion() {
    if (G.phase !== "question") return;
    stopTicking();
    // allow a short grace period for answers still in flight, then reveal
    G.qEnd = Math.min(G.qEnd, Date.now());
    $("#timer-num").textContent = "0";
    $("#ring").style.strokeDashoffset = "276.46";
    $("#timer").classList.remove("low");
    $("#btn-end").hidden = true;
    setTimeout(reveal, 900);
  }

  function reveal() {
    G.phase = "reveal";
    save();
    publishState();
    renderReveal();
  }

  function renderReveal() {
    const q = G.questions[G.qi];
    show("s-question");
    $("#q-num").textContent = `Question ${G.qi + 1} / ${G.questions.length}`;
    $("#q-text").textContent = q.q;
    renderSeeds();
    $("#timer").hidden = true;
    $("#opts").hidden = true;
    $("#chart-area").hidden = false;
    $("#btn-end").hidden = true;
    const counts = optionCounts(G.qi);
    const totalAns = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...counts);
    $("#chart").innerHTML = q.o.map((o, i) => {
      const pct = totalAns ? Math.round((counts[i] / totalAns) * 100) : 0;
      const ok = i === q.a;
      return `<div class="bar-col ${ok ? "correct" : "dim"}" style="--c:var(--opt-${i % 4})">
        <div class="bar-val">${counts[i]}<small>${pct}%</small></div>
        <div class="bar-track"><div class="bar" data-h="${(counts[i] / max) * 100}"></div></div>
        <div class="bar-label">${ok ? '<span class="tick">✓</span>' : `<span class="glyph">${Y.OPTION_ICONS[i]}</span>`}<span>${Y.esc(o)}</span></div>
      </div>`;
    }).join("");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelectorAll("#chart .bar").forEach((b, i) => setTimeout(() => (b.style.height = b.dataset.h + "%"), i * 120));
    }));
    // mini leaderboard
    const rk = ranking().slice(0, 5);
    $("#mini-board").innerHTML = `<h3>🍉 Top ${Math.min(5, rk.length) || ""}</h3>` + (rk.length ? rk.map((r, i) => {
      const a = G.players[r.id].answers[G.qi];
      return `<div class="mb-row" style="animation-delay:${600 + i * 120}ms"><span class="r">${r.rank}</span><span class="n">${Y.esc(r.name)}</span><span class="s">${r.total}${a && a.p ? `<span class="gain">+${a.p}</span>` : ""}</span></div>`;
    }).join("") : '<div class="muted">No players yet</div>');
    updateAnsweredCount();
    const last = G.qi >= G.questions.length - 1;
    const nb = $("#btn-next");
    nb.hidden = false;
    nb.textContent = last ? "See the final results 🏆" : "Next question ▶";
  }

  function next() {
    if (G.phase === "welcome") return goLobby();
    if (G.phase === "lobby") return startQuiz();
    if (G.phase === "reveal") return G.qi >= G.questions.length - 1 ? goFinal() : startQuestion(G.qi + 1);
    if (G.phase === "final" && G.finalStage === 0) return showFinalStats();
  }

  /* ---------------- background music ---------------- */
  const bgm = document.getElementById("bgm");
  bgm.volume = 0.55;
  bgm.loop = true; // repeat when the track ends
  bgm.addEventListener("ended", () => { bgm.currentTime = 0; bgm.play().catch(() => {}); }); // belt and braces
  function musicIcon() { $("#tb-music").textContent = prefs.muted ? "🔇" : "🔊"; }
  function playMusic() {
    if (prefs.muted) return;
    bgm.play().catch(() => {
      // browser blocked autoplay (e.g. after a page reload): start on the next click / key press
      const retry = () => { if (!prefs.muted && G.phase !== "welcome" && G.phase !== "lobby") bgm.play().catch(() => {}); };
      document.addEventListener("pointerdown", retry, { once: true });
      document.addEventListener("keydown", retry, { once: true });
    });
  }
  function toggleMusic() {
    prefs.muted = !prefs.muted;
    Y.store.set(PREF_KEY, prefs);
    musicIcon();
    if (prefs.muted) bgm.pause();
    else if (G.phase !== "welcome" && G.phase !== "lobby") playMusic();
  }

  function startQuiz() {
    if (!G.questions.length) return Y.toast("No questions loaded — open Settings.");
    if (!G.order.length && !confirm("No guests have joined yet. Start anyway?")) return;
    bgm.currentTime = 0;
    playMusic();
    startQuestion(0);
  }

  /* ---------------- final ---------------- */
  function goFinal() {
    G.phase = "final";
    G.finalStage = 0;
    save();
    publishState();
    renderFinal();
    setTimeout(() => downloadCSV(true), 1500);
  }

  function renderFinal() {
    show("s-final");
    if (G.finalStage === 1) return showFinalStats();
    $("#final-podium").hidden = false;
    $("#final-stats").hidden = true;
    const rk = ranking();
    const slots = [[1, "🥈", "p2", 25], [0, "🥇", "p1", 34], [2, "🥉", "p3", 18]]; // block heights in vh
    $("#podium").innerHTML = slots.map(([idx, medal, cls, h]) => {
      const r = rk[idx];
      return `<div class="pod ${cls}" data-h="${h}" data-idx="${idx}">
        <div class="who"><div class="medal">${medal}</div><div class="nm">${r ? Y.esc(r.name) : "—"}</div><div class="sc">${r ? r.total + " pts" : ""}</div></div>
        <div class="block">${idx + 1}</div></div>`;
    }).join("");
    // reveal 3rd, then 2nd, then 1st
    const pods = [...document.querySelectorAll(".pod")];
    const byIdx = (i) => pods.find((p) => +p.dataset.idx === i);
    requestAnimationFrame(() => pods.forEach((p) => (p.querySelector(".block").style.height = p.dataset.h + "vh")));
    [2, 1, 0].forEach((i, k) => setTimeout(() => {
      byIdx(i).classList.add("show");
      if (i === 0) Y.confetti(5000, 1.4);
    }, 1400 + k * 1300));
  }

  function showFinalStats() {
    G.finalStage = 1;
    save();
    $("#final-podium").hidden = true;
    $("#final-stats").hidden = false;
    const rk = ranking();
    const N = rk.length;
    const qs = G.questions;
    // per question stats
    const qstats = qs.map((q, qi) => {
      const ans = G.order.map((id) => G.players[id].answers[qi]).filter(Boolean);
      const correct = ans.filter((a) => a.c === q.a);
      return {
        qi, responses: ans.length, correct: correct.length,
        pct: ans.length ? Math.round((correct.length / ans.length) * 100) : 0,
        avgT: ans.length ? ans.reduce((s, a) => s + a.t, 0) / ans.length : 0,
      };
    });
    const allAns = qstats.reduce((s, x) => s + x.responses, 0);
    const allCorrect = qstats.reduce((s, x) => s + x.correct, 0);
    const avgScore = N ? Math.round(rk.reduce((s, r) => s + r.total, 0) / N) : 0;
    let fastest = null;
    for (const id of G.order) for (const [qi, a] of Object.entries(G.players[id].answers))
      if (a.c === qs[qi].a && (!fastest || a.t < fastest.t)) fastest = { name: G.players[id].name, t: a.t, qi: +qi };
    const kpis = [
      [N, "guests played"],
      [avgScore, "average score"],
      [(allAns ? Math.round((allCorrect / allAns) * 100) : 0) + "%", "answers correct"],
      [allAns, "answers given"],
    ];
    $("#kpis").innerHTML = kpis.map(([v, l], i) => `<div class="kpi card" style="animation-delay:${i * 100}ms"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

    const answered = qstats.filter((s) => s.responses);
    const hardest = answered.length ? answered.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    const easiest = answered.length ? answered.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
    $("#acc-chart").innerHTML = qstats.map((s) =>
      `<div class="acc-col ${hardest && s.qi === hardest.qi ? "lo" : easiest && s.qi === easiest.qi ? "hi" : ""}" title="Q${s.qi + 1}: ${Y.esc(qs[s.qi].q)} — ${s.pct}% correct (${s.correct}/${s.responses})">
        <span class="pc">${s.pct}</span><div class="acc-bar" data-h="${Math.max(2, s.pct) * 0.86}"></div></div>`).join("");
    const labels = document.querySelector(".acc-labels") || Object.assign(document.createElement("div"), { className: "acc-labels" });
    labels.innerHTML = qstats.map((s) => `<span>Q${s.qi + 1}</span>`).join("");
    $("#acc-chart").after(labels);
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.querySelectorAll(".acc-bar").forEach((b, i) => setTimeout(() => (b.style.height = b.dataset.h + "%"), i * 50))));
    const short = (t) => (t.length > 60 ? t.slice(0, 57) + "…" : t);
    $("#acc-notes").innerHTML = [
      hardest ? `<div><b>Toughest</b>Q${hardest.qi + 1} · ${hardest.pct}% — ${Y.esc(short(qs[hardest.qi].q))}</div>` : "",
      easiest ? `<div><b>Easiest</b>Q${easiest.qi + 1} · ${easiest.pct}% — ${Y.esc(short(qs[easiest.qi].q))}</div>` : "",
      fastest ? `<div><b>Fastest correct answer</b>${Y.esc(fastest.name)} · ${(fastest.t / 1000).toFixed(1)}s on Q${fastest.qi + 1}</div>` : "",
    ].join("");

    const top = Math.max(1, rk[0] ? rk[0].total : 1);
    const medals = ["🥇", "🥈", "🥉"];
    $("#ranking").innerHTML = rk.map((r, i) =>
      `<li style="animation-delay:${Math.min(i, 25) * 40}ms"><span class="fill" style="width:${(r.total / top) * 100}%"></span>
        <span class="rk">${r.rank <= 3 ? medals[r.rank - 1] : r.rank}</span>
        <span class="nm">${Y.esc(r.name)}<small>${r.correct}/${qs.length} ✓</small></span>
        <span class="sc">${r.total}</span></li>`).join("") || '<li class="muted">No players</li>';
  }

  /* ---------------- CSV ---------------- */
  function csvCell(v) {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function download(name, rows) {
    const text = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

  function downloadCSV(auto) {
    const qs = G.questions;
    const head = ["Rank", "Name", "Total Score", "Correct Answers", "Questions Answered", "Accuracy %", "Avg Response Time (s)", "Joined At"];
    qs.forEach((_, i) => head.push(`Q${i + 1} Answer`, `Q${i + 1} Correct`, `Q${i + 1} Points`, `Q${i + 1} Time (s)`));
    const rows = [head];
    for (const r of ranking()) {
      const p = G.players[r.id];
      const ans = Object.values(p.answers);
      const row = [r.rank, r.name, r.total, r.correct, r.answered, r.answered ? Math.round((r.correct / r.answered) * 100) : 0,
        ans.length ? (ans.reduce((s, a) => s + a.t, 0) / ans.length / 1000).toFixed(2) : "", new Date(p.joined).toLocaleString()];
      qs.forEach((q, qi) => {
        const a = p.answers[qi];
        row.push(a ? q.o[a.c] : "", a ? (a.c === q.a ? "Yes" : "No") : "", a ? a.p : 0, a ? (a.t / 1000).toFixed(2) : "");
      });
      rows.push(row);
    }
    download(`yalda-quiz-results_${stamp()}.csv`, rows);
    if (auto) Y.toast("Results saved to your Downloads folder as CSV ✓", 4000);
  }

  function downloadQuestionCSV() {
    const qs = G.questions;
    const maxO = Math.max(...qs.map((q) => q.o.length));
    const head = ["#", "Question", "Correct Answer", "Responses", "Correct", "Correct %", "Avg Time (s)"];
    for (let i = 0; i < maxO; i++) head.push(`Option ${Y.OPTION_LETTERS[i]}`, `Option ${Y.OPTION_LETTERS[i]} Votes`);
    const rows = [head];
    qs.forEach((q, qi) => {
      const counts = optionCounts(qi);
      const ans = G.order.map((id) => G.players[id].answers[qi]).filter(Boolean);
      const correct = ans.filter((a) => a.c === q.a).length;
      const row = [qi + 1, q.q, q.o[q.a] ?? "", ans.length, correct, ans.length ? Math.round((correct / ans.length) * 100) : 0,
        ans.length ? (ans.reduce((s, a) => s + a.t, 0) / ans.length / 1000).toFixed(2) : ""];
      for (let i = 0; i < maxO; i++) row.push(q.o[i] ?? "", q.o[i] != null ? counts[i] : "");
      rows.push(row);
    });
    download(`yalda-quiz-questions_${stamp()}.csv`, rows);
  }

  /* ---------------- settings ---------------- */
  function openSettings() {
    const sel = $("#set-broker");
    sel.innerHTML = Y.BROKERS.map((b, i) => `<option value="${i}">${Y.esc(b.name)} — ${Y.esc(b.url.replace(/^wss:\/\//, ""))}</option>`).join("");
    sel.value = G.broker;
    const locked = !["welcome", "lobby"].includes(G.phase);
    sel.disabled = locked;
    $("#set-time").value = G.seconds;
    $("#set-time").disabled = locked && G.phase === "question";
    $("#set-load").disabled = $("#set-reset-q").disabled = locked;
    $("#set-qinfo").textContent = `${questions.length} questions loaded (${Y.store.get(Q_KEY) ? "from your file" : "built-in"}).`;
    $("#dlg-settings").showModal();
  }
  function applySettings() {
    const b = +$("#set-broker").value;
    const secs = Math.max(5, Math.min(180, +$("#set-time").value || 10));
    prefs.seconds = secs; prefs.broker = b; Y.store.set(PREF_KEY, prefs);
    if (G.phase !== "question") G.seconds = secs;
    if (["welcome", "lobby"].includes(G.phase)) {
      G.questions = questions;
      if (b !== G.broker) { G.broker = b; connect(); }
      if (G.phase === "lobby") renderLobby();
    }
    save();
  }

  function newGame() {
    if (net && G) pub("state", null, { retain: true }); // clear the old room's retained state
    stopTicking();
    bgm.pause(); bgm.currentTime = 0;
    G = freshGame();
    save();
    connect();
    goWelcome();
  }

  function restore(saved) {
    G = saved;
    connect();
    if (!["welcome", "lobby"].includes(G.phase)) playMusic();
    switch (G.phase) {
      case "welcome": show("s-welcome"); break;
      case "lobby": renderLobby(); show("s-lobby"); break;
      case "question":
        if (Date.now() < G.qEnd) { renderQuestion(); startTicking(); }
        else { reveal(); }
        break;
      case "reveal": renderReveal(); break;
      case "final": renderFinal(); break;
    }
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    $("#btn-to-lobby").onclick = goLobby;
    $("#s-welcome .welcome-frame").onclick = goLobby;
    $("#btn-start").onclick = startQuiz;
    $("#btn-end").onclick = endQuestion;
    $("#btn-next").onclick = next;
    $("#btn-stats").onclick = showFinalStats;
    $("#btn-back-podium").onclick = () => { G.finalStage = 0; save(); renderFinal(); };
    $("#btn-csv").onclick = () => downloadCSV(false);
    $("#btn-csv-q").onclick = downloadQuestionCSV;
    $("#btn-new").onclick = () => { if (confirm("Start a new game? Make sure you have downloaded the CSV.")) newGame(); };
    $("#tb-prev").onclick = () => { if (G.phase === "lobby") goWelcome(); else if (G.phase === "welcome") goLobby(); };
    $("#tb-full").onclick = toggleFull;
    $("#tb-settings").onclick = openSettings;
    $("#tb-music").onclick = toggleMusic;
    musicIcon();
    $("#set-ok").onclick = () => { $("#dlg-settings").close(); applySettings(); };
    $("#set-newgame").onclick = () => { if (confirm("Start a brand-new game with a new room code? Current players and scores will be cleared.")) { $("#dlg-settings").close(); newGame(); } };
    $("#set-load").onclick = () => $("#set-file").click();
    $("#set-file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const parsed = Y.parseMCQ(await f.text());
      const bad = parsed.filter((q) => q.a < 0).map((q, i) => i + 1);
      if (!parsed.length) return Y.toast("Couldn't read any questions from that file.");
      if (bad.length) alert(`Warning: no "Correct" marker found for ${bad.length} question(s). Mark the right option by ending its line with "Correct".`);
      questions = parsed; Y.store.set(Q_KEY, parsed);
      $("#set-qinfo").textContent = `${parsed.length} questions loaded (from your file).`;
      e.target.value = "";
    };
    $("#set-reset-q").onclick = () => { questions = builtIn; Y.store.del(Q_KEY); $("#set-qinfo").textContent = `${builtIn.length} questions loaded (built-in).`; };

    document.addEventListener("keydown", (e) => {
      if (document.querySelector("dialog[open]") || e.target.matches("input,select,textarea")) return;
      const k = e.key;
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(k)) { e.preventDefault(); next(); }
      else if (["ArrowLeft", "PageUp"].includes(k)) { if (G.phase === "lobby") goWelcome(); else if (G.phase === "final" && G.finalStage === 1) { G.finalStage = 0; save(); renderFinal(); } }
      else if (k === "f" || k === "F") toggleFull();
      else if (k === "m" || k === "M") toggleMusic();
      else if ((k === "e" || k === "E") && G.phase === "question") endQuestion();
    });
    window.addEventListener("resize", () => { if (G.phase === "lobby") renderLobbyNames(); });
  }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  }

  /* ---------------- boot ---------------- */
  Y.startSky($("#sky"));
  Y.startSky($("#welcome-snow"), { stars: false, snow: 0.8 });
  $("#qr-pom").innerHTML = Y.pomegranateSVG(110, true);
  $("#candles").innerHTML = Y.candleSVG(30) + Y.candleSVG(36) + Y.candleSVG(30);
  wire();

  const saved = Y.store.get(SAVE_KEY);
  if (saved && saved.phase && saved.phase !== "welcome" && (saved.order?.length || saved.phase !== "lobby")) {
    const desc = saved.phase === "final" ? "finished" : saved.phase === "lobby" ? "in the lobby" : `on question ${saved.qi + 1}`;
    $("#resume-info").textContent = `A game with room code ${saved.room} is ${desc}, with ${saved.order.length} player(s). Resume it, or start fresh?`;
    const dlg = $("#dlg-resume");
    let decided = false;
    const decide = (fresh) => { if (decided) return; decided = true; if (dlg.open) dlg.close(); fresh ? newGame() : restore(saved); };
    $("#resume-yes").onclick = () => decide(false);
    $("#resume-new").onclick = () => decide(true);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); decide(false); }); // Esc = resume
    dlg.showModal();
  } else if (saved && saved.room) {
    restore(Object.assign(saved, { questions, seconds: prefs.seconds, broker: prefs.broker }));
  } else newGame();
})();
