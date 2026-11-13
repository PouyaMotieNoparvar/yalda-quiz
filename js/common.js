/* ============ Yalda Night Quiz — shared helpers ============ */
(function () {
  "use strict";

  // Public MQTT-over-WebSocket brokers (free, no account). The host picks one and
  // its index is carried in the QR link so every phone uses the same broker.
  // shiftr.io is first because it runs on the normal HTTPS port 443, which works on
  // university / venue Wi-Fi that blocks unusual ports (8084, 8884, 8081).
  const BROKERS = [
    { name: "shiftr.io (port 443)", url: "wss://public.cloud.shiftr.io", username: "public", password: "public" },
    { name: "EMQX public", url: "wss://broker.emqx.io:8084/mqtt" },
    { name: "HiveMQ public", url: "wss://broker.hivemq.com:8884/mqtt" },
    { name: "Mosquitto test", url: "wss://test.mosquitto.org:8081/mqtt" },
  ];
  const TOPIC_ROOT = "ugal-iransoc-yalda/v1";

  const Y = (window.Yalda = {});
  Y.BROKERS = BROKERS;
  Y.topic = (room, sub) => `${TOPIC_ROOT}/${room}/${sub}`;
  Y.OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];
  Y.OPTION_ICONS = ["◆", "●", "▲", "■", "★", "✚"];

  Y.esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  Y.rid = (n = 8, abc = "abcdefghijkmnpqrstuvwxyz23456789") => {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => abc[x % abc.length]).join("");
  };

  Y.store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  Y.decodeQuiz = (enc) => {
    const key = new TextEncoder().encode("yalda-shab-e-chelleh");
    const bin = atob(enc);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length];
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  /** Parse the plain MCQ.txt format (same rules as tools/build_questions.py). */
  Y.parseMCQ = (text) => {
    const out = [];
    for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 3) continue;
      const q = lines[0].replace(/^\d+\s*[-.)]\s*/, "");
      const o = [];
      let a = -1;
      lines.slice(1).forEach((l, i) => {
        const m = l.match(/^(.*?)\s+correct\s*$/i);
        if (m) { a = i; l = m[1]; }
        o.push(l);
      });
      out.push({ q, o, a });
    }
    return out;
  };

  /* ---------- networking ---------- */
  Y.connect = function (brokerIndex, onStatus) {
    const b = BROKERS[brokerIndex] || BROKERS[0];
    const handlers = [];
    const client = mqtt.connect(b.url, {
      clientId: "yq_" + Y.rid(12),
      keepalive: 30,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      clean: true,
      resubscribe: true,
      ...(b.username ? { username: b.username, password: b.password } : {}),
    });
    const set = (s, t) => onStatus && onStatus(s, t);
    set("warn", "Connecting…");
    client.on("connect", () => set("ok", "Live"));
    client.on("reconnect", () => set("warn", "Reconnecting…"));
    client.on("offline", () => set("bad", "Offline"));
    client.on("error", (e) => { console.warn("MQTT error", e); set("bad", "Connection error"); });
    client.on("message", (topic, payload) => {
      let data = null;
      if (payload && payload.length) {
        try { data = JSON.parse(payload.toString()); } catch { return; }
      }
      for (const h of handlers) if (h.match(topic)) h.fn(data, topic);
    });
    const matcher = (filter) => {
      if (!filter.includes("+") && !filter.includes("#")) return (t) => t === filter;
      const re = new RegExp("^" + filter.replace(/[.*?^${}()|[\]\\]/g, "\\$&").replace(/\+/g, "[^/]+").replace(/#/g, ".*") + "$");
      return (t) => re.test(t);
    };
    return {
      client,
      sub(filter, fn) {
        handlers.push({ match: matcher(filter), fn });
        client.subscribe(filter, { qos: 1 });
      },
      pub(topic, obj, opts = {}) {
        const payload = obj == null ? "" : JSON.stringify(obj);
        client.publish(topic, payload, { qos: opts.qos ?? 1, retain: !!opts.retain });
      },
      get connected() { return client.connected; },
    };
  };

  Y.setStatus = (el, state, text) => {
    if (!el) return;
    el.className = "status-chip " + state;
    el.innerHTML = `<i></i>${Y.esc(text)}`;
  };

  /* ---------- night sky: stars + snow ---------- */
  Y.startSky = function (canvas, opts = {}) {
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W, H, dpr, stars = [], flakes = [];
    const snowDensity = opts.snow ?? 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const area = W * H;
      stars = opts.stars === false ? [] : Array.from({ length: Math.round(area / 5000) }, () => ({
        x: Math.random() * W, y: Math.random() * H * 0.75, r: Math.random() * 1.3 + 0.2,
        p: Math.random() * Math.PI * 2, s: 0.5 + Math.random() * 1.5,
      }));
      const n = Math.round((area / 9000) * snowDensity * (reduce ? 0.3 : 1));
      flakes = Array.from({ length: n }, () => newFlake(true));
    }
    function newFlake(anywhere) {
      const z = Math.random();
      return {
        x: Math.random() * W, y: anywhere ? Math.random() * H : -10,
        r: 0.8 + z * 2.8, vy: 0.3 + z * 1.1, vx: (Math.random() - 0.5) * 0.3,
        sw: Math.random() * Math.PI * 2, a: 0.35 + z * 0.6,
      };
    }
    let last = performance.now();
    function frame(t) {
      const dt = Math.min(3, (t - last) / 16.67); last = t;
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        const tw = reduce ? 0.8 : 0.55 + 0.45 * Math.sin(s.p + t * 0.001 * s.s);
        ctx.globalAlpha = tw;
        ctx.fillStyle = "#fff8e6";
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i];
        f.sw += 0.01 * dt;
        f.y += f.vy * dt; f.x += (f.vx + Math.sin(f.sw) * 0.35) * dt;
        if (f.y > H + 10 || f.x < -20 || f.x > W + 20) flakes[i] = newFlake(false);
        ctx.globalAlpha = f.a;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(frame);
  };

  /* ---------- confetti: pomegranate seeds, snow & gold ---------- */
  Y.confetti = function (duration = 3500, power = 1) {
    let c = document.getElementById("confetti");
    if (!c) { c = document.createElement("canvas"); c.id = "confetti"; document.body.appendChild(c); }
    const ctx = c.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = (c.width = innerWidth * dpr), H = (c.height = innerHeight * dpr);
    const colors = ["#c8102e", "#ff4d6a", "#f2c46d", "#ffffff", "#2e9e5b", "#9b1030"];
    const N = Math.round(160 * power);
    const parts = Array.from({ length: N }, (_, i) => {
      const fromLeft = i % 2 === 0;
      return {
        x: fromLeft ? 0 : W, y: H * 0.75,
        vx: (fromLeft ? 1 : -1) * (6 + Math.random() * 12) * dpr,
        vy: -(12 + Math.random() * 16) * dpr,
        r: (3 + Math.random() * 5) * dpr, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        col: colors[(Math.random() * colors.length) | 0], seed: Math.random() < 0.45,
      };
    });
    const start = performance.now();
    function frame(t) {
      const el = t - start;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.45 * dpr; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - el / duration);
        ctx.fillStyle = p.col;
        if (p.seed) { // pomegranate aril: glossy teardrop
          ctx.beginPath(); ctx.ellipse(0, 0, p.r * 0.75, p.r * 1.05, 0, 0, 6.283); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.55)";
          ctx.beginPath(); ctx.arc(-p.r * 0.25, -p.r * 0.35, p.r * 0.22, 0, 6.283); ctx.fill();
        } else ctx.fillRect(-p.r, -p.r * 0.4, p.r * 2, p.r * 0.8);
        ctx.restore();
      }
      if (el < duration) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  };

  /* ---------- illustrations ---------- */
  Y.pomegranateSVG = (size = 120, open = false) => `
<svg class="pom-svg" width="${size}" height="${size}" viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <radialGradient id="pg${size}" cx="38%" cy="35%" r="70%">
      <stop offset="0" stop-color="#ff5a6e"/><stop offset=".45" stop-color="#c8102e"/><stop offset="1" stop-color="#5c0716"/>
    </radialGradient>
  </defs>
  <path d="M52 22 L50 10 L56 16 L60 6 L64 16 L70 10 L68 22 Z" fill="#8a0c22" stroke="#5c0716" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="60" cy="66" r="44" fill="url(#pg${size})"/>
  <ellipse cx="44" cy="48" rx="12" ry="7" fill="#fff" opacity=".18" transform="rotate(-30 44 48)"/>
  ${open ? `
  <path d="M60 66 m-30 0 a30 30 0 0 0 60 0 Z" fill="#f6d9b8"/>
  ${[[42,74],[50,80],[58,84],[66,80],[74,74],[46,86],[56,92],[66,90],[76,84],[62,72],[52,72],[70,68],[40,68]].map(([x,y])=>`<ellipse cx="${x}" cy="${y}" rx="3.6" ry="4.4" fill="#d7193a"/><circle cx="${x-1}" cy="${y-1.5}" r="1" fill="#fff" opacity=".7"/>`).join("")}` : ""}
</svg>`;

  Y.watermelonSVG = (size = 110) => `
<svg class="pom-svg" width="${size}" height="${size * 0.62}" viewBox="0 0 110 68" aria-hidden="true">
  <path d="M4 6 A51 51 0 0 0 106 6 Z" fill="#2e9e5b"/>
  <path d="M10 6 A45 45 0 0 0 100 6 Z" fill="#e8f5d0"/>
  <path d="M14 6 A41 41 0 0 0 96 6 Z" fill="#e8384f"/>
  ${[[30,16],[44,26],[55,18],[66,26],[80,16],[55,36],[40,14],[70,14]].map(([x,y])=>`<ellipse cx="${x}" cy="${y}" rx="2" ry="3.2" fill="#2a0a0a"/>`).join("")}
</svg>`;

  Y.candleSVG = (size = 46) => `
<svg width="${size}" height="${size * 1.6}" viewBox="0 0 46 74" aria-hidden="true">
  <ellipse cx="23" cy="22" rx="14" ry="20" fill="#ffcc66" opacity=".18"><animate attributeName="opacity" values=".12;.26;.15;.22;.12" dur="2.4s" repeatCount="indefinite"/></ellipse>
  <path d="M23 8 C30 18 29 27 23 30 C17 27 16 18 23 8 Z" fill="#ffb627"><animateTransform attributeName="transform" type="rotate" values="-3 23 30;3 23 30;-2 23 30" dur="1.3s" repeatCount="indefinite"/></path>
  <path d="M23 16 C26 21 26 26 23 28 C20 26 20 21 23 16 Z" fill="#fff4c2"/>
  <rect x="21.8" y="28" width="2.4" height="6" fill="#3a2a1a"/>
  <rect x="11" y="34" width="24" height="36" rx="4" fill="#fbeedd"/>
  <rect x="11" y="34" width="24" height="6" rx="3" fill="#f3dcc0"/>
</svg>`;

  Y.toast = (msg, ms = 2600) => {
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
  };
})();
