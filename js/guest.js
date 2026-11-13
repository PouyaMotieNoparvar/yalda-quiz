/* ============ Yalda Night Quiz — guest phone ============ */
(function () {
  "use strict";
  const Y = window.Yalda;
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  let room = (params.get("r") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const broker = Math.max(0, Math.min(Y.BROKERS.length - 1, parseInt(params.get("b") || "0", 10) || 0));

  let me = null;            // { id, name, ans: { [qi]: choice } }
  let net = null;
  let state = null;
  let clockOffset = 0;      // hostTime - localTime
  let haveClock = false;
  let tick = null;
  let renderedKey = "";
  let retry = null;

  const meKey = () => `yalda_guest_${room}`;
  const saveMe = () => Y.store.set(meKey(), me);

  function show(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === id));
    document.body.dataset.screen = id;
  }

  /* ---------------- join ---------------- */
  function showJoin() {
    show("g-join");
    $("#room-label").hidden = !!room && !!params.get("r");
    if (me && me.name) $("#name-input").value = me.name;
  }

  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#name-input").value.replace(/\s+/g, " ").trim().slice(0, 24);
    if (!$("#room-label").hidden) {
      const r = $("#room-input").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!r) return Y.toast("Please enter the room code from the big screen.");
      if (r !== room) {
        room = r;
        history.replaceState(null, "", `?r=${room}${broker ? "&b=" + broker : ""}`);
        me = Y.store.get(meKey()) || null;
        startNet();
      }
    }
    if (!name) return Y.toast("Please enter your name.");
    me = me || { id: Y.rid(12), ans: {} };
    me.name = name;
    me.joined = true;
    saveMe();
    sendJoin();
    renderWait();
    if (state) onState(state);
    requestWakeLock();
  });
  $("#change-name").onclick = () => { me.joined = false; saveMe(); showJoin(); $("#name-input").focus(); };

  function sendJoin() {
    if (!net || !me || !me.joined) return;
    net.pub(Y.topic(room, "join"), { id: me.id, name: me.name });
  }

  /* ---------------- incoming ---------------- */
  function startNet() {
    if (net) try { net.client.end(true); } catch {}
    state = null; renderedKey = "";
    net = Y.connect(broker, (s, t) => Y.setStatus($("#status"), s, t));
    net.client.on("connect", sendJoin);
    net.sub(Y.topic(room, "state"), (s) => {
      if (s && typeof s.now === "number" && !haveClock) clockOffset = s.now - Date.now();
      onState(s);
    });
    net.sub(Y.topic(room, "clock"), (c) => { if (c) { clockOffset = c.now - Date.now(); haveClock = true; } });
    if (me) subscribeAck();
  }
  let ackSubbed = "";
  function subscribeAck() {
    if (!me || ackSubbed === me.id + room) return;
    ackSubbed = me.id + room;
    net.sub(Y.topic(room, `ack/${me.id}`), (a) => {
      if (!a) return;
      if (a.t === "join" && a.name && a.name !== me.name) { me.name = a.name; saveMe(); $("#wait-name").textContent = me.name; }
      if (a.t === "ans" && state && state.ph === "q" && a.qi === state.qi) {
        clearTimeout(retry);
        $("#gq-locked").innerHTML = `✅ <b>Answer received!</b><br>Wait for the timer to finish…`;
      }
    });
  }

  function onState(s) {
    if (s === null) {
      state = null;
      return showMsg("❄", "This quiz room has closed", "Ask the host for the new QR code.");
    }
    state = s;
    const joined = me && me.joined;
    if (me) subscribeAck();
    if (!joined) {
      if (s.ph === "f") return showMsg("🍉", "This quiz has finished", "Thanks for coming to Yalda Night!");
      if (!$("#g-join").classList.contains("active")) showJoin();
      return;
    }
    if (s.ph === "lobby") return renderWait();
    if (s.ph === "q") return renderQuestion();
    if (s.ph === "r") return renderReveal();
    if (s.ph === "f") return renderFinal();
  }

  /* ---------------- screens ---------------- */
  function renderWait() {
    stopTick();
    $("#wait-name").textContent = me.name;
    $("#wait-n").textContent = state ? state.n : "…";
    if (state && state.secs) $("#wait-secs").textContent = state.secs;
    if (renderedKey === "wait") return;
    renderedKey = "wait";
    show("g-wait");
  }

  function renderQuestion() {
    const s = state;
    const key = "q" + s.qi;
    const mine = me.ans[s.qi];
    if (renderedKey !== key) {
      renderedKey = key;
      show("g-q");
      $("#gq-num").textContent = `Question ${s.qi + 1} / ${s.total}`;
      $("#gq-text").textContent = s.q;
      const box = $("#gq-opts");
      box.className = "gq-opts";
      box.innerHTML = s.o.map((o, i) =>
        `<button class="gq-opt" data-i="${i}" style="--c:var(--opt-${i % 4});animation-delay:${i * 70}ms"><span class="glyph">${Y.OPTION_ICONS[i]}</span><span>${Y.esc(o)}</span></button>`).join("");
      box.querySelectorAll(".gq-opt").forEach((b) => (b.onclick = () => answer(+b.dataset.i)));
      $("#gq-locked").hidden = true;
      if (navigator.vibrate) navigator.vibrate(60);
    }
    if (mine != null) lockUI(mine, true);
    startTick();
  }

  function answer(i) {
    const s = state;
    if (!s || s.ph !== "q" || me.ans[s.qi] != null) return;
    if (hostNow() > s.endsAt + 1000) return Y.toast("Time's up! ⏰");
    me.ans[s.qi] = i;
    saveMe();
    lockUI(i, false);
    const send = (n) => {
      net.pub(Y.topic(room, "ans"), { id: me.id, qi: s.qi, c: i });
      if (n > 0) retry = setTimeout(() => state && state.ph === "q" && state.qi === s.qi && send(n - 1), 2500);
    };
    send(3);
    if (navigator.vibrate) navigator.vibrate(30);
  }

  function lockUI(i, already) {
    const box = $("#gq-opts");
    box.classList.add("locked");
    box.querySelectorAll(".gq-opt").forEach((b) => { b.disabled = true; b.classList.toggle("picked", +b.dataset.i === i); });
    const l = $("#gq-locked");
    l.hidden = false;
    if (!already || !/received/.test(l.innerHTML)) l.innerHTML = `🔒 <b>Answer locked in.</b><br>Sending…`;
  }

  const hostNow = () => Date.now() + clockOffset;
  function startTick() {
    if (tick) return;
    const upd = () => {
      if (!state || state.ph !== "q") return stopTick();
      const total = (state.secs || 30) * 1000;
      const left = Math.max(0, Math.min(total, state.endsAt - hostNow()));
      $("#gq-time").textContent = Math.ceil(left / 1000);
      $("#gq-time").classList.toggle("low", left <= 5000 && left > 0);
      $("#gq-bar-fill").style.width = (left / total) * 100 + "%";
      if (left <= 0 && me.ans[state.qi] == null) {
        const box = $("#gq-opts");
        if (!box.classList.contains("locked")) {
          box.classList.add("locked");
          box.querySelectorAll(".gq-opt").forEach((b) => (b.disabled = true));
          $("#gq-locked").hidden = false;
          $("#gq-locked").innerHTML = "⏰ <b>Time's up!</b>";
        }
      }
    };
    upd();
    tick = setInterval(upd, 200);
  }
  function stopTick() { clearInterval(tick); tick = null; }

  function renderReveal() {
    stopTick();
    clearTimeout(retry);
    const s = state;
    const key = "r" + s.qi;
    if (renderedKey === key) return;
    renderedKey = key;
    const r = (s.res && s.res[me.id]) || null; // [pts, total, rank, choice]
    const choice = r ? r[3] : me.ans[s.qi] ?? -1;
    const ok = choice === s.a;
    const v = $("#verdict");
    v.className = "verdict " + (ok ? "ok" : "no");
    v.innerHTML = choice < 0
      ? `<div class="icon">⏰</div><h2>No answer</h2><div class="pts">+0</div>`
      : ok ? `<div class="icon">🎉</div><h2>Correct!</h2><div class="pts">+${r ? r[0] : "?"} points</div>`
           : `<div class="icon">❄️</div><h2>Not quite</h2><div class="pts">+0</div>`;
    $("#right-answer").textContent = s.o[s.a];
    $("#your-answer").textContent = choice >= 0 && !ok ? `You answered: ${s.o[choice]}` : "";
    $("#r-total").textContent = r ? r[1] : 0;
    $("#r-rank").textContent = r ? `#${r[2]}` : "–";
    $("#r-rank").nextElementSibling.textContent = `of ${s.n} guests`;
    show("g-r");
    if (ok) { Y.confetti(2200, 0.6); if (navigator.vibrate) navigator.vibrate([40, 60, 40]); }
    else if (navigator.vibrate) navigator.vibrate(150);
  }

  function renderFinal() {
    stopTick();
    const s = state;
    if (renderedKey === "f") return;
    renderedKey = "f";
    const r = (s.res && s.res[me.id]) || null; // [total, rank, correct]
    $("#f-score").textContent = r ? r[0] : 0;
    const medal = r && r[1] <= 3 ? ["🥇", "🥈", "🥉"][r[1] - 1] + " " : "";
    $("#f-rank").textContent = r ? `${medal}Rank ${r[1]} of ${s.n}` : "You joined after the scoring";
    $("#f-correct").textContent = r ? `${r[2]} of ${s.total} answers correct` : "";
    $("#f-top").innerHTML = `<h3>Top of the night</h3>` + (s.top || []).map((t, i) =>
      `<div class="row"><span>${["🥇", "🥈", "🥉"][i]} ${Y.esc(t[0])}</span><span class="gold">${t[1]}</span></div>`).join("");
    $("#final-art").innerHTML = Y.pomegranateSVG(90, true) + Y.watermelonSVG(100);
    show("g-f");
    Y.confetti(r && r[1] <= 3 ? 6000 : 3500, r && r[1] <= 3 ? 1.5 : 0.8);
  }

  function showMsg(icon, title, text) {
    stopTick();
    renderedKey = "msg";
    $("#msg-art").innerHTML = `<div style="font-size:4rem">${icon}</div>`;
    $("#msg-title").textContent = title;
    $("#msg-text").textContent = text;
    show("g-msg");
  }

  /* keep the phone awake during the quiz */
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (me && me.joined) { requestWakeLock(); sendJoin(); }
      if (net && !net.connected) net.client.reconnect();
    }
  });

  /* ---------------- boot ---------------- */
  Y.startSky($("#sky"), { snow: 0.7 });
  $("#wait-pom").innerHTML = Y.pomegranateSVG(140, true);
  if (!room) {
    showJoin();
    $("#room-label").hidden = false;
    Y.setStatus($("#status"), "warn", "Enter room code");
  } else {
    me = Y.store.get(meKey());
    if (me && me.joined) renderWait(); else showJoin();
    startNet();
  }
})();
