"use strict";
// claude-desk web app: vanilla JS, no build step. All user data goes through textContent (h()).

const REACTIONS = [["wave", "👋"], ["thumbs", "👍"], ["laugh", "😂"], ["coffee", "☕"], ["fire", "🔥"],
  ["heart", "❤️"], ["hug", "🤗"], ["kiss", "😘"], ["goodnight", "🌙"], ["missyou", "🥺"]];
const EMOJI = Object.fromEntries(REACTIONS);
const MSG_MAX = 100;
const ERRORS = {
  credentials: "Wrong username or password.", invite: "That invite code isn't right.", taken: "That username is taken.",
  username: "Username: 3-20 characters, a-z 0-9 _", password: "Password must be at least 8 characters.",
  rate_limited: "Slow down a little and try again in a minute.", no_such_user: "No user with that name.",
  self: "That's you.", invalid_code: "No device is showing that code. Check the screen and try again.",
  code: "The pair code has 6 digits.", not_friends: "You're not friends yet.",
  too_long: "Messages are up to 100 characters.", empty: "Type something first.", auth: "Please sign in again.",
  tz: "Unknown timezone.", network: "Can't reach the hub.",
  busy: "An update is running. Give it a couple of minutes.", offline: "The desk is offline.",
  spotify_not_configured: "Spotify isn't set up on this hub yet (it needs a Spotify app ID).", slack_not_configured: "Slack isn't set up on this hub yet.",
  lastfm_not_configured: "Last.fm isn't set up on this hub yet (it needs an API key).", lastfm_user: "No Last.fm user with that name.",
  lastfm_unreachable: "Couldn't reach Last.fm. Try again in a minute.", oauth_state: "That sign-in took too long. Try again.",
  media_unreadable: "Couldn't read that picture. Try a JPG, PNG or GIF.", media_too_big: "That GIF is too long for the desk, even shortened.",
  media_full: "You have 30 saved. Delete a few first.", media_input_big: "That file is too big (12 MB max).",
  spotify_invite_only: "Spotify sign-in on this hub only works for invited accounts for now. Use Last.fm below; it works with Spotify too.",
  lastfm_denied: "Last.fm sign-in was cancelled.", lastfm_failed: "Last.fm sign-in failed.",
  google_denied: "Google sign-in was cancelled.", google_failed: "Google sign-in failed.",
  google_scope: "Google didn't share your calendar. Sign in again and tick the calendar box.",
  google_not_configured: "Google sign-in isn't set up on this hub yet.",
  spotify_denied: "Spotify sign-in was cancelled.", slack_denied: "Slack sign-in was cancelled.", spotify_failed: "Spotify sign-in failed.", slack_failed: "Slack sign-in failed.",
  no_location: "Set your desk's location first (Devices → your desk → Location).", email_host: "That mail server can't be used.",
  email_login: "The mail server refused that address and app password.", email_unreachable: "Couldn't reach that mail server.",
  label: "Give it a name.", days: "Pick at least one day.", time: "Check the times.", every: "Pick how often.", strokes: "That drawing data was invalid.",
  downgrade: "The desk already runs newer firmware than the hub has.",
  wifi_pass: "Wi-Fi passwords are 8 to 63 characters (or leave it empty for an open network).", ssid: "Network names are 1 to 32 characters.",
  minutes: "Pick 1 to 720 minutes.", too_many: "That's the maximum for this.", duplicate: "You already added that.",
  url: "Paste the calendar link.", calendar_not_a_calendar: "That link isn't a calendar (.ics) link.", calendar_https_only: "Use the https:// version of the link.",
  calendar_unreachable: "Couldn't reach that calendar.", calendar_dns: "That calendar address doesn't exist.", calendar_private_address: "That address isn't allowed.",
  calendar_too_big: "That calendar is too big.", calendar_bad_url: "That isn't a valid link.",
  github_token: "GitHub didn't accept that token.", github_unreachable: "Couldn't reach GitHub. Try again in a minute.",
  symbol: "Symbols look like AAPL, BTC-USD or EURUSD=X.", level: "Price levels must be positive numbers.", remind: "Pick a reminder time from the list.",
};

const state = { me: null, config: null, friends: [], devices: [], route: "", poll: null };
const $app = document.getElementById("app");
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** replaceChildren that accepts nested arrays and skips null/false. */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(3).filter((k) => k != null && k !== false));
  return el;
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error(ERRORS.network), { code: "network" });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") { state.me = null; if (!/^#\/(login|install)/.test(location.hash)) go("#/login"); }
  if (!res.ok) throw Object.assign(new Error(ERRORS[data.error] || "Something went wrong."), { code: data.error, status: res.status });
  return data;
}

let toastT;
function toast(msg, bad) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ""), 2400);
}
const fail = (e) => toast(e.message || String(e), true);

function guarded(fn) {
  let running = false;
  return async (e) => {
    e?.preventDefault?.();
    if (running) return;
    running = true;
    const el = e?.currentTarget;
    const btns = !el ? [] : el.tagName === "FORM" ? [...el.querySelectorAll("button[type=submit]")] : [el];
    btns.forEach((b) => { b.disabled = true; });
    try { await fn(e); } finally { running = false; btns.forEach((b) => { b.disabled = false; }); }
  };
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch {
    const ta = h("textarea", {}, text); document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch { toast("Copy failed", true); }
    ta.remove();
  }
}

function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
function clock(t) {
  const d = new Date(t * 1000), now = new Date();
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (d.toDateString() !== now.toDateString()) Object.assign(opts, { month: "short", day: "numeric" });
  return d.toLocaleString([], opts);
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

// ------------------------------------------------------------------ layout
const TABS = [["#/home", "💬", "Home"], ["#/friends", "👥", "Friends"], ["#/devices", "🖥️", "Devices"], ["#/apps", "🧩", "Apps"], ["#/settings", "⚙️", "Settings"]];

function claudePill() {
  const v = state.me && state.me.claude;
  if (!v) return null;
  const label = { idle: "Claude idle", working: "Claude working", needs: "Claude needs you", done: "Claude done" }[v.s] || v.s;
  return h("span", { class: "pill " + v.s, title: v.d || "" }, label);
}

function shell(title, content, opts = {}) {
  const incoming = state.friends.filter((f) => f.pendingFrom === "them").length;
  const top = h("header", { class: "top" },
    opts.back ? h("button", { class: "back", "aria-label": "Back", onclick: () => go(opts.back) }, "‹") : h("span", { class: "brand-dot" }),
    h("h1", {}, title),
    opts.action ? h("button", { class: "hdr-btn", type: "button", "aria-label": opts.action.label, title: opts.action.label, onclick: opts.action.onclick }, opts.action.icon) : null,
    claudePill());
  const nav = h("nav", { class: "tabs" }, h("div", { class: "inner" }, TABS.map(([href, ic, label]) =>
    h("a", { href, class: state.route.startsWith(href.slice(1)) || (href === "#/home" && state.route.startsWith("/chat")) || (href === "#/devices" && state.route.startsWith("/device/")) ? "on" : "" },
      h("span", { class: "ic" }, ic), label,
      href === "#/friends" && incoming ? h("span", { class: "badge" }, incoming) : null))));
  const main = h("main", { class: opts.chat ? "chat" : "" }, content);
  fill($app, top, main, opts.chat ? null : nav);
  return main;
}

// ------------------------------------------------------------------ auth
function viewLogin() {
  let mode = "login";
  const err = h("div", { class: "err" });
  const f = {
    username: h("input", { autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: 20, required: true }),
    displayName: h("input", { maxlength: 20, placeholder: "Shown on friends' screens" }),
    password: h("input", { type: "password", autocomplete: "current-password", maxlength: 200, required: true }),
    invite: h("input", { autocomplete: "off", autocapitalize: "none", maxlength: 100 }),
  };
  const extra = h("div", {});
  const submit = h("button", { class: "btn primary block", type: "submit" }, "Sign in");
  const seg = h("div", { class: "seg" });
  function paint() {
    seg.replaceChildren(
      h("button", { type: "button", class: mode === "login" ? "on" : "", onclick: () => { mode = "login"; paint(); } }, "Sign in"),
      h("button", { type: "button", class: mode === "register" ? "on" : "", onclick: () => { mode = "register"; paint(); } }, "Create account"));
    fill(extra, mode === "register" ? [
      h("label", { class: "f" }, "Display name"), f.displayName,
      state.config && state.config.inviteRequired ? [h("label", { class: "f" }, "Invite code"), f.invite] : null,
    ] : null);
    f.password.setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
    submit.textContent = mode === "login" ? "Sign in" : "Create account";
    err.textContent = "";
  }
  paint();
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; submit.disabled = true;
      const body = { username: f.username.value.trim().toLowerCase(), password: f.password.value, tz: browserTz() };
      if (mode === "register") Object.assign(body, { displayName: f.displayName.value.trim(), invite: f.invite.value.trim() });
      try {
        await api("POST", mode === "login" ? "/api/login" : "/api/register", body);
        await loadMe(); go("#/home");
      } catch (ex) { err.textContent = ex.message; }
      finally { submit.disabled = false; }
    },
  }, seg, h("label", { class: "f" }, "Username"), f.username, h("label", { class: "f" }, "Password"), f.password, extra, submit, err);
  $app.replaceChildren(h("div", { class: "auth" },
    h("div", { class: "logo" }, h("img", { src: "/favicon.svg", alt: "" }),
      h("div", {}, h("h1", {}, "claude-desk"), h("p", {}, "Your desk, your friends, your Claude."))),
    form,
    h("p", { class: "hint", style: "text-align:center;margin-top:22px" }, "New desk? ", h("a", { href: "#/install" }, "Install guide"))));
}

const DESK_ADDR_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9-]{1,63}\.local$/i;
const deskHostFor = (u) => (u.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user") + "-desk";
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { return; } }

async function viewInstall() {
  const hubHost = location.host;
  const fw = await fetch("/firmware/latest.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const addr = h("input", { inputmode: "url", autocapitalize: "none", autocomplete: "off", spellcheck: "false", placeholder: "192.168.1.107", value: lsGet("cd_desk_addr") });
  const addrHint = h("p", { class: "hint" });
  const updateLink = h("a", { class: "btn primary block", target: "_blank", rel: "noopener" }, "Open the desk's update page");
  const hubLink = h("a", { class: "btn primary block", target: "_blank", rel: "noopener" }, "Connect the desk to " + hubHost);
  const deskAddr = () => addr.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  function sync() {
    const a = deskAddr(), ok = DESK_ADDR_RE.test(a);
    if (ok || !a) lsSet("cd_desk_addr", a);
    for (const [el, url] of [[updateLink, `http://${a}/update`], [hubLink, `http://${a}/set?hub=${encodeURIComponent(hubHost)}`]]) {
      if (ok) { el.href = url; el.classList.remove("off"); el.removeAttribute("aria-disabled"); }
      else { el.removeAttribute("href"); el.classList.add("off"); el.setAttribute("aria-disabled", "true"); }
    }
    addrHint.textContent = ok ? "Got it. The buttons in steps 3 and 4 open this desk."
      : a ? "Type the numbers exactly as the screen shows them, like 192.168.1.107."
      : "The buttons in steps 3 and 4 need it.";
  }
  addr.addEventListener("input", sync);
  sync();
  const dl = (file, label, cls) => h("a", { class: cls, href: "/firmware/" + file, download: file }, label);
  const step = (n, title, ...body) => h("div", { class: "card step" }, h("div", { class: "step-head" }, h("span", { class: "num" }, n), title), body);
  const body = [
    h("p", { class: "hint" }, "For a GeekMagic SmallTV Ultra (not the Pro). Everything works from your phone and you only do it once: after that, settings and updates come from this site."),
    step(1, "Put the desk on your Wi-Fi",
      h("p", {}, "Plug it in. Its screen names a Wi-Fi network to join (on a new GeekMagic usually ", h("b", {}, "GIFTV"), " or ", h("b", {}, "SmallTV"), ")."),
      h("p", {}, "Join that network on your phone. If no page opens by itself, go to ", h("b", {}, "192.168.4.1"), ". Pick your home Wi-Fi and enter its password."),
      h("p", {}, "Switch your phone back to the same home Wi-Fi. The desk's screen now shows its address. Type it here:"),
      addr, addrHint),
    step(2, "Download claude-desk",
      h("p", {}, "Save this file on your phone. On an iPhone it goes to Files › Downloads. Don't open it: you pick it in the next step."),
      dl("claude-desk.bin.gz", "Download claude-desk" + (fw && fw.version ? " " + fw.version : ""), "btn block"),
      h("p", { class: "hint" }, "Desk already runs claude-desk? Skip to step 4.")),
    step(3, "Install it",
      h("p", {}, "Open the desk's update page, choose the file you just downloaded and tap ", h("b", {}, "Update"), "."),
      updateLink,
      h("p", {}, "After about 30 seconds the desk restarts, shows CONNECTING…, then CLAUDE DESK with its address."),
      h("details", {}, h("summary", {}, "The update page refused the file"),
        h("p", {}, "Install it in two steps instead, on the same update page:"),
        h("ol", {},
          h("li", {}, "Upload the ", dl("claude-desk-loader.bin", "loader"), ". The desk restarts showing LOADER."),
          h("li", {}, "Upload the ", dl("claude-desk.bin", "full firmware"), ". The desk restarts into claude-desk."))),
      h("details", {}, h("summary", {}, "The desk shows SETUP"),
        h("p", {}, "Join the ", h("b", {}, "claude-desk-setup"), " Wi-Fi, open 192.168.4.1 and pick your home Wi-Fi again. Then switch your phone back to it."))),
    step(4, "Connect it to this site",
      h("p", {}, "One tap tells the desk where your account lives."),
      hubLink,
      h("p", {}, "The desk restarts and shows ", h("b", {}, "PAIR THIS DESK"), " with a 6-digit code."),
      h("p", { class: "hint" }, "If the address on the screen changed, update it in step 1.")),
    step(5, "Pair it with your account",
      state.me
        ? [h("p", {}, "Enter the code on the Devices page."),
          h("a", { class: "btn primary block", href: "#/devices" }, "Pair on Devices"),
          h("p", { class: "hint" }, `Afterwards it's on your Wi-Fi as ${deskHostFor(state.me.username)}.local.`)]
        : [h("p", {}, "Create your account (or sign in), open ", h("b", {}, "Devices"), " and enter the code."),
          h("a", { class: "btn primary block", href: "#/login" }, "Create account or sign in")]),
    step(6, "Set it up from here",
      h("p", {}, "Location, brightness, night hours, colours and emoji style are on the desk's page under Devices, and so is the update button. For Claude Code status, calendar reminders, GitHub, timers and more, open ",
        h("a", { href: "#/apps" }, "Apps"), ".")),
  ];
  if (state.me) shell("Install a desk", body, { back: "#/devices" });
  else $app.replaceChildren(h("div", { class: "auth guide" },
    h("div", { class: "logo" }, h("img", { src: "/favicon.svg", alt: "" }),
      h("div", {}, h("h1", {}, "Install claude-desk"), h("p", {}, "Set up a new desk from your phone"))),
    body));
}

// ------------------------------------------------------------------ home + chat
const DRAW_COLORS = ["#ffffff", "#000000", "#f05a50", "#ff8c42", "#ffd03e", "#6ec878", "#3cc8b4", "#64a0ff", "#b482ff", "#ff96ac", "#a0643c", "#9a9890"];
const DRAW_SIZES = [["S", 3], ["M", 7], ["L", 14]];
const toB64 = (arr) => { let s = ""; for (let i = 0; i < arr.length; i += 4096) s += String.fromCharCode(...arr.slice(i, i + 4096)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0));

function drawBytes(ctx, bytes, scale, st = {}) {
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let i = 0; i < bytes.length;) {
    if (bytes[i] === 0xfe) { ctx.fillStyle = DRAW_COLORS[bytes[i + 1]] || "#000"; ctx.fillRect(0, 0, 240 * scale, 240 * scale); st.px = null; i += 2; continue; }
    if (bytes[i] === 0xff) { st.c = DRAW_COLORS[bytes[i + 1]] || "#fff"; st.w = bytes[i + 2]; st.px = null; i += 3; continue; }
    const x = bytes[i], y = bytes[i + 1];
    i += 2;
    ctx.strokeStyle = st.c; ctx.fillStyle = st.c; ctx.lineWidth = st.w * scale;
    ctx.beginPath();
    if (st.px == null) { ctx.arc(x * scale, y * scale, (st.w * scale) / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.moveTo(st.px * scale, st.py * scale); ctx.lineTo(x * scale, y * scale); ctx.stroke(); }
    st.px = x; st.py = y;
  }
  return st;
}

function doodleThumb(b64, size = 140) {
  const c = h("canvas", { width: 240, height: 240, class: "thumb", style: `width:${size}px;height:${size}px` });
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 240, 240);
  drawBytes(ctx, fromB64(b64), 1);
  return c;
}

async function openDoodle({ to = null, id = null, title, onClose = null }) {
  try { if (!id) id = (await api("POST", "/api/doodles", { to })).id; } catch (e) { return fail(e); }
  const own = !to;
  const canvas = h("canvas", { width: 480, height: 480, class: "draw-canvas" });
  const ctx = canvas.getContext("2d");
  const clearCanvas = () => { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 480, 480); };
  clearCanvas();
  let color = 6, size = 7, tool = "pen", ended = false, inflight = false, stroke = null, lastPt = null, seq = 0, shape = null;
  let queue = [];
  const swatches = h("div", { class: "swatches" });
  const sizes = h("div", { class: "seg seg-3", style: "width:min(92vw,440px)" });
  const tools = h("div", { class: "seg seg-4", style: "width:min(92vw,440px)" });
  const paintTools = () => {
    fill(tools, [["pen", "✏️ Pen"], ["line", "╱ Line"], ["rect", "▢ Box"], ["circle", "◯ Circle"]].map(([v, l]) =>
      h("button", { type: "button", class: tool === v ? "on" : "", onclick: () => { tool = v; paintTools(); } }, l)));
    fill(swatches, DRAW_COLORS.map((c, i) => h("button", { type: "button", class: "sw" + (i === color ? " on" : ""), style: `background:${c}`,
      title: i === 1 ? "Eraser" : "", "aria-label": i === 1 ? "Eraser" : "Colour", onclick: () => { color = i; paintTools(); } }, i === 1 ? "⌫" : "")));
    fill(sizes, DRAW_SIZES.map(([l, v]) => h("button", { type: "button", class: size === v ? "on" : "", onclick: () => { size = v; paintTools(); } }, l)));
  };
  paintTools();
  const add = (k, arr) => {
    const last = queue[queue.length - 1];
    if (last && last.k === k) last.bytes.push(...arr); else queue.push({ k, bytes: [...arr], carry: 0 });
  };
  const flush = async () => {
    if (inflight || ended) return;
    queue = queue.filter((it, i) => it.bytes.length > it.carry || (stroke && stroke.k === it.k && i === queue.length - 1));
    const item = queue[0];
    if (!item || item.bytes.length <= item.carry) return;
    queue.shift();
    if (stroke && stroke.k === item.k && lastPt) queue.unshift({ k: item.k, bytes: [0xff, stroke.c, stroke.w, ...lastPt], carry: 5 });
    inflight = true;
    try { await api("POST", `/api/doodles/${id}/strokes`, { s: toB64(item.bytes), k: item.k }); } catch (e) { fail(e); }
    inflight = false;
  };
  const drain = async () => {
    for (let i = 0; i < 100 && (inflight || queue.some((it) => it.bytes.length > it.carry)); i++) {
      await flush();
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const shapePoints = (a, b) => {
    const [x0, y0] = a, [x1, y1] = b;
    if (tool === "line") return [x0, y0, x1, y1];
    if (tool === "rect") return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    const n = Math.max(16, Math.min(60, Math.round((rx + ry) / 2)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push(Math.max(0, Math.min(239, Math.round(cx + rx * Math.cos(t)))), Math.max(0, Math.min(239, Math.round(cy + ry * Math.sin(t)))));
    }
    return pts;
  };
  const timer = setInterval(flush, 100);
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(239, Math.round(((e.clientX - r.left) / r.width) * 240))), Math.max(0, Math.min(239, Math.round(((e.clientY - r.top) / r.height) * 240)))];
  };
  const local = {};
  canvas.addEventListener("pointerdown", (e) => {
    if (ended) return;
    canvas.setPointerCapture(e.pointerId);
    const p = pt(e);
    if (tool !== "pen") {
      shape = { from: p, to: p, snap: ctx.getImageData(0, 0, 480, 480) };
      return;
    }
    stroke = { c: color, w: size, k: ++seq };
    lastPt = p;
    add(stroke.k, [0xff, color, size, ...p]);
    drawBytes(ctx, Uint8Array.from([0xff, color, size, ...p]), 2, local);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (ended) return;
    if (shape) {
      shape.to = pt(e);
      ctx.putImageData(shape.snap, 0, 0);
      drawBytes(ctx, Uint8Array.from([0xff, color, size, ...shapePoints(shape.from, shape.to)]), 2);
      return;
    }
    if (!stroke) return;
    const p = pt(e);
    if (Math.abs(p[0] - lastPt[0]) + Math.abs(p[1] - lastPt[1]) < 2) return;
    add(stroke.k, p);
    drawBytes(ctx, Uint8Array.from(p), 2, local);
    lastPt = p;
  });
  const up = () => {
    if (shape) {
      const bytes = [0xff, color, size, ...shapePoints(shape.from, shape.to)];
      ctx.putImageData(shape.snap, 0, 0);
      drawBytes(ctx, Uint8Array.from(bytes), 2);
      add(++seq, bytes);
      shape = null;
      return;
    }
    stroke = null; lastPt = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  const me = state.me && state.me.username;
  const es = new EventSource(`/api/doodles/${id}/events`);
  es.addEventListener("init", (ev) => { const d = JSON.parse(ev.data); clearCanvas(); drawBytes(ctx, fromB64(d.data), 2); });
  es.addEventListener("strokes", (ev) => { const d = JSON.parse(ev.data); if (d.by !== me) drawBytes(ctx, fromB64(d.s), 2); });
  es.addEventListener("clear", (ev) => { const d = JSON.parse(ev.data); if (d.by !== me) { clearCanvas(); toast("Canvas cleared"); } });
  es.addEventListener("reset", (ev) => { const d = JSON.parse(ev.data); clearCanvas(); drawBytes(ctx, fromB64(d.s), 2); });
  es.addEventListener("end", () => { if (!ended) { ended = true; toast("Drawing saved"); close(); } });
  const close = () => { ended = true; clearInterval(timer); es.close(); dlg.remove(); if (onClose) onClose(); else if (state.route.startsWith("/chat/")) render(); };
  const dlg = h("div", { class: "draw-overlay" },
    h("div", { class: "draw-head" }, h("b", {}, title || (own ? "Your canvas" : "Drawing")),
      h("span", { class: "hint", style: "margin:0" }, own ? "Shows on your desk as you draw" : "Live on both desks; you can both draw")),
    canvas, tools, swatches, sizes,
    h("div", { class: "actions", style: "justify-content:center" },
      h("button", { class: "btn small", title: "Fill the whole canvas with the colour", onclick: () => {
        if (ended) return;
        const bytes = [0xfe, color];
        drawBytes(ctx, Uint8Array.from(bytes), 2);
        add(++seq, bytes);
      } }, "🪣 Fill"),
      h("button", { class: "btn small", onclick: guarded(async () => {
        await drain();
        try { const r = await api("POST", `/api/doodles/${id}/undo`); if (!r.undone) toast("Nothing of yours to undo"); } catch (e) { fail(e); }
      }) }, "↶ Undo"),
      h("button", { class: "btn small", onclick: guarded(async () => {
        if (!confirm("Clear the canvas for everyone?")) return;
        queue = []; clearCanvas();
        try { await api("POST", `/api/doodles/${id}/clear`); } catch (e) { fail(e); }
      }) }, "Clear")),
    h("div", { class: "actions", style: "justify-content:center" },
      h("button", { class: "btn small primary", onclick: guarded(async () => {
        await drain();
        try { await api("POST", `/api/doodles/${id}/end`, { secs: own ? keepGet() : 60 }); ended = true; toast("Drawing saved"); close(); } catch (e) { fail(e); }
      }) }, "Done"),
      own ? h("button", { class: "btn small ghost", onclick: guarded(async () => {
        await drain();
        try { await api("POST", "/api/doodles/hide"); ended = true; toast("Back to the clock"); close(); } catch (e) { fail(e); }
      }) }, "Back to clock")
        : h("button", { class: "btn small ghost", onclick: guarded(async () => { await drain(); close(); }) }, "Leave")),
    own ? h("p", { class: "hint", style: "text-align:center;max-width:440px" }, "Done keeps it on your desk (for how long is set on your desk's page). Back to clock saves it and shows the clock now.") : null,
    own ? null : h("p", { class: "hint", style: "text-align:center;max-width:440px" }, "Leave keeps the drawing open for your friend. Done saves it in your chat for both of you."));
  document.body.append(dlg);
}

async function activeDoodlesBanner(filterUser) {
  let list = [];
  try { list = await api("GET", "/api/doodles/active"); } catch { return null; }
  list = list.filter((d) => d.with && (!filterUser || d.with === filterUser));
  if (!list.length) return null;
  return h("div", { class: "list", style: "margin-bottom:10px" }, list.map((d) => h("div", { class: "row tap", onclick: () => openDoodle({ to: d.with, id: d.id, title: `Drawing with ${d.withName}` }) },
    h("div", { class: "avatar" }, "✏️"),
    h("div", { class: "grow" }, h("div", { class: "title" }, d.startedByMe ? `Your drawing with ${d.withName}` : `${d.withName} is drawing with you`),
      h("div", { class: "sub" }, "Live · tap to join")),
    h("span", { class: "chev" }, "›"))));
}

function presenceText(p) {
  if (!p.away) return "at their computer";
  const s = Math.max(0, Date.now() / 1000 - p.since);
  return s < 3600 ? `away ${Math.max(10, Math.round(s / 60))} min` : s < 86400 ? `away ${Math.floor(s / 3600)} h` : "away";
}

async function viewHome() {
  const main = shell("claude-desk", h("div", { class: "empty" }, "Loading…"));
  await loadFriends();
  const friends = state.friends.filter((f) => f.rel);
  const list = friends.length
    ? h("div", { class: "list" }, friends.map((f) => h("div", { class: "row tap", onclick: () => go("#/chat/" + f.username) },
        h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
        h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName, f.presence ? h("span", { class: "dot " + (f.presence.away ? "away" : "here") }) : null),
          h("div", { class: "sub" }, "@" + f.username + (f.presence ? " · " + presenceText(f.presence) : ""))),
        h("span", { class: "chev" }, "›"))))
    : h("div", { class: "card empty" }, "No friends yet. ", h("a", { href: "#/friends" }, "Add someone"), " to send messages to their desk.");
  const live = await activeDoodlesBanner(null);
  fill(main, live ? [h("h2", {}, "Live drawings"), live] : null, h("h2", {}, "Send to a desk"), list,
    state.friends.some((f) => f.pendingFrom === "them") ? h("p", { class: "hint" }, h("a", { href: "#/friends" }, "You have friend requests waiting.")) : null);
}

async function viewChat(username) {
  if (!state.friends.length) await loadFriends().catch(() => {});
  const fr = state.friends.find((f) => f.username === username);
  const msgs = h("div", { class: "msgs" });
  const input = h("input", { maxlength: MSG_MAX, placeholder: "Message to their desk…", enterkeyhint: "send", autocomplete: "off" });
  const count = h("span", { class: "count" }, "0/" + MSG_MAX);
  const sendBtn = h("button", { class: "btn primary", type: "submit" }, "Send");
  input.addEventListener("input", () => {
    const n = [...input.value].length;
    count.textContent = n + "/" + MSG_MAX; count.className = "count" + (n > MSG_MAX ? " over" : "");
  });

  async function send(body) {
    try {
      const r = await api("POST", "/api/messages", { to: username, ...body });
      toast(r.devices ? "Sent to their desk" : "Sent (they have no desk paired yet)");
      await refresh();
    } catch (e) { fail(e); }
  }
  const reactBtn = ([key, emoji]) => h("button", {
    type: "button", title: key, "aria-label": key,
    onclick: guarded(() => send({ kind: "reaction", reaction: key })),
  }, emoji);
  const composer = h("div", { class: "composer" },
    h("div", { class: "reacts" },
      h("button", { type: "button", class: "draw-btn", title: "Draw together", "aria-label": "Draw together",
        onclick: () => openDoodle({ to: username, title: `Drawing with ${fr ? fr.displayName : "@" + username}` }) }, "✏️"),
      h("button", { type: "button", class: "draw-btn", title: "Send a photo or GIF", "aria-label": "Send a photo or GIF",
        onclick: () => sendMediaSheet(username, fr ? fr.displayName : "@" + username, () => { last = ""; refresh(); }) }, "🖼️"),
      REACTIONS.map(reactBtn)),
    h("form", {
      class: "inline", onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if ([...text].length > MSG_MAX) return toast(ERRORS.too_long, true);
        sendBtn.disabled = true;
        await send({ kind: "text", text });
        input.value = ""; input.dispatchEvent(new Event("input")); sendBtn.disabled = false; input.focus();
      },
    }, input, count, sendBtn));

  let last = "", first = true;
  async function refresh() {
    const list = await api("GET", "/api/messages?with=" + encodeURIComponent(username));
    const sig = list.map((m) => m.id).join(",");
    if (sig === last) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    last = sig;
    msgs.replaceChildren(...(list.length ? list.map((m) => m.kind === "doodle"
      ? h("div", { class: "bubble react" + (m.mine ? " mine" : "") }, doodleThumb(m.doodle), h("span", { class: "meta" }, "drawing · " + clock(m.t)))
      : m.kind === "media"
      ? h("div", { class: "bubble react" + (m.mine ? " mine" : "") }, m.media && m.media.kind ? mediaImg(m.media.id, 140) : "🖼️",
        h("span", { class: "meta" }, (m.media && m.media.kind === "gif" ? "GIF" : m.media && m.media.kind ? "photo" : "deleted") + " · " + clock(m.t)))
      : m.kind === "reaction"
      ? h("div", { class: "bubble react" + (m.mine ? " mine" : ""), title: m.reaction }, EMOJI[m.reaction] || m.reaction, h("span", { class: "meta" }, clock(m.t)))
      : h("div", { class: "bubble" + (m.mine ? " mine" : "") }, m.text, h("span", { class: "meta" }, clock(m.t))))
      : [h("div", { class: "empty" }, "Say hi. It pops up on their desk.")]));
    if (atBottom || first) window.scrollTo(0, document.body.scrollHeight);
    first = false;
  }

  const liveBox = h("div", {});
  const refreshLive = async () => { const b = await activeDoodlesBanner(username); fill(liveBox, b); };
  shell(fr ? fr.displayName : "@" + username, [fr && fr.presence ? h("p", { class: "hint", style: "margin:0 0 8px;text-align:center" }, h("span", { class: "dot " + (fr.presence.away ? "away" : "here") }), " " + presenceText(fr.presence)) : null, liveBox, msgs, fr && fr.rel ? composer : h("div", { class: "empty" }, "You're not friends with @" + username + ".")], { back: "#/home", chat: true });
  await refresh().catch(fail);
  refreshLive();
  state.poll = setInterval(() => { if (!document.hidden) { refresh().catch(() => {}); refreshLive(); } }, 4000);
}

// ------------------------------------------------------------------ friends
async function viewFriends() {
  const main = shell("Friends", h("div", { class: "empty" }, "Loading…"));
  await loadFriends();
  const username = h("input", { placeholder: "username", autocapitalize: "none", spellcheck: "false", maxlength: 20 });
  const add = h("form", {
    class: "card", onsubmit: guarded(async () => {
      const u = username.value.trim().toLowerCase().replace(/^@/, "");
      if (!u) return;
      try {
        const r = await api("POST", "/api/friends", { username: u });
        toast(r.rel ? "You're connected" : "Request sent");
        viewFriends();
      } catch (ex) { fail(ex); }
    }),
  }, h("div", { class: "inline" }, username, h("button", { class: "btn primary", type: "submit" }, "Add")),
    h("p", { class: "hint", style: "margin-bottom:0" }, "Once they accept, you can send each other messages and reactions."));

  const act = (method, url, msg) => async () => { try { await api(method, url); if (msg) toast(msg); viewFriends(); } catch (e) { fail(e); } };
  const incoming = state.friends.filter((f) => f.pendingFrom === "them");
  const outgoing = state.friends.filter((f) => f.pendingFrom === "me");
  const current = state.friends.filter((f) => f.rel);
  const enc = encodeURIComponent;

  fill(main,
    h("h2", {}, "Add"), add,
    incoming.length ? [h("h2", {}, "Requests"), h("div", { class: "list" }, incoming.map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName),
        h("div", { class: "sub" }, "@" + f.username + " · wants to connect")),
      h("div", { class: "actions" },
        h("button", { class: "btn small primary", onclick: guarded(act("POST", `/api/friends/${enc(f.username)}/accept`, "Accepted")) }, "Accept"),
        h("button", { class: "btn small ghost", onclick: guarded(act("POST", `/api/friends/${enc(f.username)}/decline`)) }, "Decline")))))] : null,
    h("h2", {}, "Your people"),
    current.length ? h("div", { class: "list" }, current.map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName),
        h("div", { class: "sub" }, "@" + f.username)),
      h("div", { class: "actions" },
        h("button", { class: "btn small ghost", "aria-label": "Options", onclick: () => friendMenu(f) }, "•••")))))
      : h("div", { class: "card empty" }, "Nobody yet."),
    outgoing.filter((f) => !f.rel).length ? [h("h2", {}, "Sent"), h("div", { class: "list" }, outgoing.filter((f) => !f.rel).map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName), h("div", { class: "sub" }, `@${f.username} · request pending`)),
      h("button", { class: "btn small ghost", onclick: guarded(act("POST", `/api/friends/${enc(f.username)}/decline`, "Cancelled")) }, "Cancel"))))] : null,
  );

}

function friendMenu(f) {
  const enc = encodeURIComponent(f.username);
  const close = () => dlg.remove();
  const doIt = (fn) => async () => { close(); try { await fn(); viewFriends(); } catch (e) { fail(e); } };
  const dlg = h("div", { style: "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:20;display:flex;align-items:flex-end;justify-content:center", onclick: (e) => { if (e.target === dlg) close(); } },
    h("div", { class: "card", style: "width:100%;max-width:560px;border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom))" },
      h("div", { class: "title", style: "font-weight:600;margin-bottom:12px" }, f.displayName + " · @" + f.username),
      h("button", { class: "btn block danger", style: "margin-top:0", onclick: doIt(async () => {
        if (!confirm(`Remove @${f.username}? You won't be able to message each other.`)) return;
        await api("DELETE", `/api/friends/${enc}`); toast("Removed");
      }) }, "Remove"),
      h("button", { class: "btn block ghost", style: "margin-top:8px", onclick: close }, "Close")));
  document.body.append(dlg);
}

// ------------------------------------------------------------------ devices
const addDeskAction = { icon: "+", label: "Add a desk", onclick: () => go("#/devices/add") };

async function viewDevices() {
  shell("Devices", h("div", { class: "empty" }, "Loading…"));
  state.devices = await api("GET", "/api/devices");
  if (state.devices.length === 1) return await viewDevice(state.devices[0].chip);
  if (!state.devices.length) return viewAddDevice();
  shell("Your desks", h("div", { class: "list" }, state.devices.map((d) => h("div", { class: "row tap", onclick: () => go("#/device/" + d.chip) },
    h("div", { class: "grow" },
      h("div", { class: "title" }, h("span", { class: "dot" + (d.online ? " on" : "") }), d.name || "Desk"),
      h("div", { class: "sub" }, [d.online ? "online" : "last seen " + ago(d.lastSeen), d.host ? d.host + ".local" : null, d.fw ? "fw " + d.fw : null].filter(Boolean).join(" · "))),
    h("span", { class: "chev" }, "›")))), { action: addDeskAction });
}

function viewAddDevice() {
  const first = !state.devices.length;
  const code = h("input", { inputmode: "numeric", pattern: "[0-9 ]*", maxlength: 7, placeholder: "482913", autocomplete: "one-time-code" });
  const name = h("input", { maxlength: 20, placeholder: "Desk", value: first ? ((state.me && state.me.displayName) || "Desk").slice(0, 20) : "" });
  const pair = h("form", {
    class: "card", onsubmit: guarded(async () => {
      try {
        await api("POST", "/api/devices/pair", { code: code.value.replace(/\s/g, ""), name: name.value.trim() || "Desk" });
        toast("Paired! Your desk will switch over in a moment."); go("#/devices");
      } catch (ex) { fail(ex); }
    }),
  }, h("label", { class: "f", style: "margin-top:0" }, "Pair code shown on the device"), code,
    h("label", { class: "f" }, "Name"), name, h("button", { class: "btn primary block", type: "submit" }, "Pair device"));
  shell(first ? "Pair your desk" : "Add a desk", [pair,
    h("p", { class: "hint" }, "Power on your GeekMagic with the claude-desk firmware. It shows a 6-digit code until it's paired. New desk? ",
      h("a", { href: "#/install" }, "Install guide"), ".")], first ? {} : { back: "#/devices" });
}

// ------------------------------------------------------------------ one desk: status + remote settings
const DEFAULT_SETTINGS = { layout: 1, soft: 0, casper: 1, h12: 0, tf: 0, face: 1, pack: "pixel", bday: 25, bnight: 10, nstart: 22, nend: 7 };
const versionNewer = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const SAVE_KEYS = ["layout", "soft", "casper", "h12", "tf", "face", "pack", "bday", "bnight", "nstart", "nend"];

function appNotify() {
  const el = h("div", { class: "card" });
  let p = null;
  const put = async (body) => { try { p = await api("PUT", "/api/notify-prefs", body); } catch (e) { fail(e); } paint(); };
  const pick = (key, options) => {
    const s = h("div", { class: "seg seg-" + options.length });
    fill(s, options.map(([val, label]) => h("button", { type: "button", class: p[key] === val ? "on" : "", onclick: () => put({ [key]: val }) }, label)));
    return s;
  };
  const time = (key) => {
    const i = h("input", { type: "time", value: fromMin(p[key]) });
    i.addEventListener("change", () => put({ [key]: toMin(i.value) }));
    return i;
  };
  const STYLES = [["full", "Full screen"], ["banner", "Banner"]];
  function paint() {
    if (!p) return fill(el, h("p", { class: "hint", style: "margin:0" }, "Loading…"));
    fill(el,
      toggle("Do not disturb", p.dnd, (v) => put({ dnd: v })),
      h("p", { class: "hint", style: "margin:2px 0 8px 28px" }, p.quietNow ? "Quiet now: nothing pops up. Messages wait as a small line under the date." : "Nothing pops up while it's on. Claude asking for permission always shows."),
      toggle("Quiet hours", p.quiet, (v) => put({ quiet: v })),
      p.quiet ? h("div", { class: "two" }, h("div", {}, h("label", { class: "f" }, "From"), time("qfrom")), h("div", {}, h("label", { class: "f" }, "Until"), time("qto"))) : null,
      h("label", { class: "f" }, "Friend messages"), pick("msg", STYLES),
      h("label", { class: "f" }, "App notifications"), pick("app", STYLES),
      h("label", { class: "f" }, "Claude finished"), pick("done", [...STYLES, ["off", "Off"]]),
      h("p", { class: "hint", style: "margin:6px 0 0" }, "Banner keeps the clock and slides the text across the top."),
      h("label", { class: "f" }, "Messages stay for"), pick("secs", [[5, "5 s"], [15, "15 s"], [30, "30 s"], [60, "1 min"], [180, "3 min"]]),
      h("label", { class: "f" }, "Banner speed"), pick("speed", [[1, "Slow"], [2, "Normal"], [3, "Fast"]]),
      h("label", { class: "f" }, "Notifications from"),
      p.sources.map((s) => toggle(s, !p.off.includes(s), (v) => put({ off: v ? p.off.filter((x) => x !== s) : [...p.off, s] }))));
  }
  paint();
  api("GET", "/api/notify-prefs").then((r) => { p = r; paint(); }).catch(() => {});
  return el;
}
const LOW_HEAP = 8 * 1024;
const CRASH_RE = /exception|watchdog|wdt/i;
const hourLabel = (n) => String(n).padStart(2, "0") + ":00";

async function viewDevice(chip) {
  const enc = encodeURIComponent(chip);
  if (state.devices.length !== 1 || state.devices[0].chip !== chip) state.devices = await api("GET", "/api/devices");
  const nav = state.devices.length === 1 ? { action: addDeskAction } : { back: "#/devices" };
  shell("Desk", h("div", { class: "empty" }, "Loading…"), nav);
  let data;
  try { data = await api("GET", `/api/devices/${enc}/settings`); }
  catch (e) { if (e.status === 404) { toast("That desk isn't yours (or was forgotten).", true); return go("#/devices"); } throw e; }

  const v = { ...DEFAULT_SETTINGS, ...(data.reported || {}), ...(data.settings || {}) };
  let place = data.place || null, locChanged = false, inFlight = null;
  const nm = () => data.device.name || "Desk";
  const main = shell(nm(), [], nav);

  // ---- status card (refreshed by polling, form below is left alone)
  const status = h("div", { class: "card" });
  function paintStatus() {
    const d = data.device, fw = data.firmware;
    const rep = data.reported, want = data.settings;
    const sync = !want ? null
      : rep && rep.rev >= want.rev ? h("span", { class: "ok" }, `✓ ${nm()} is using your latest settings`)
      : h("span", { class: "warn" }, d.online ? `Sending settings to ${nm()}…` : `Settings will apply when ${nm()} comes online`);
    const updating = d.otaPending || inFlight === "ota";
    const locked = !!inFlight || updating;
    const canUpdate = fw && d.fw && versionNewer(fw.version, d.fw);
    const otaLine = updating ? null : d.ota ? `Last update: ${d.ota}${d.otaAt ? " (" + ago(d.otaAt) + ")" : ""}` : null;
    fill(status,
      h("div", { class: "title" }, h("span", { class: "dot" + (d.online ? " on" : "") }), d.online ? "Online" : "Offline · last seen " + ago(d.lastSeen)),
      h("div", { class: "kv" },
        "firmware", h("b", {}, (d.fw || "?") + (fw ? (canUpdate ? ` → ${fw.version} available` : fw.version === d.fw ? " (latest)" : "") : "")),
        d.host ? ["local", h("b", {}, h("a", { href: `http://${d.host}.local`, target: "_blank", rel: "noopener" }, `${d.host}.local`))] : null,
        d.ip ? ["ip", h("b", {}, d.ip)] : null,
        d.rssi != null ? ["wi-fi", h("b", {}, d.rssi + " dBm")] : null,
        d.heap != null ? ["memory", h("b", { class: d.heap < LOW_HEAP ? "warn" : "" },
          `${(d.heap / 1024).toFixed(1)} KB free` + (d.heap < LOW_HEAP ? " · low" : ""))] : null,
        d.reset && CRASH_RE.test(d.reset) ? ["last restart", h("b", { class: "warn" }, d.reset)] : null,
        "chip", h("b", {}, d.chip),
        rep && rep.packs ? ["packs", h("b", {}, rep.packs.join(", "))] : null),
      sync ? h("p", { class: "hint", style: "margin:10px 0 0" }, sync) : null,
      updating ? h("p", { class: "hint warn", style: "margin:10px 0 0" },
        `Updating${fw ? " to " + fw.version : ""}… ${nm()} restarts twice while it installs (1–3 minutes). Keep it plugged in.`) : null,
      otaLine ? h("p", { class: "hint", style: "margin:6px 0 0" }, otaLine) : null,
      h("div", { class: "actions", style: "margin-top:12px" },
        updating ? h("button", { class: "btn small primary", disabled: true }, "Updating…")
          : canUpdate ? h("button", { class: "btn small primary", disabled: locked, onclick: () => command("ota", `Update ${nm()} to ${fw.version}? It restarts twice while it installs (1–3 minutes).`) }, "Update firmware") : null,
        h("button", { class: "btn small", disabled: locked || !d.online, onclick: () => command("reboot", `Restart ${nm()}?`) }, "Restart"),
        h("button", { class: "btn small", disabled: !!inFlight, onclick: rename }, "Rename"),
        h("button", { class: "btn small ghost danger", disabled: locked, onclick: forget }, "Forget")));
  }
  async function act(kind, fn) {
    if (inFlight) return;
    inFlight = kind; paintStatus();
    try { await fn(); } catch (e) { fail(e); } finally { inFlight = null; await refresh().catch(() => paintStatus()); }
  }
  function command(cmd, question) {
    if (inFlight || !confirm(question)) return;
    return act(cmd, async () => {
      await api("POST", `/api/devices/${enc}/${cmd}`);
      toast(cmd === "ota" ? `Update sent to ${nm()}.` : `Restarting ${nm()}…`);
    });
  }
  function rename() {
    if (inFlight) return;
    const n = prompt("Desk name", nm());
    if (n == null || n.trim() === nm()) return;
    return act("rename", async () => {
      await api("PATCH", `/api/devices/${enc}`, { name: n.trim() || "Desk" });
      data = await api("GET", `/api/devices/${enc}/settings`);
      document.querySelector("header h1").textContent = nm(); syncSave();
    });
  }
  function forget() {
    if (inFlight || !confirm(`Forget "${nm()}"? It will show a new pair code and needs to be paired again.`)) return;
    return act("forget", async () => { await api("DELETE", `/api/devices/${enc}`); toast("Forgotten"); go("#/devices"); });
  }
  async function refresh() { data = await api("GET", `/api/devices/${enc}/settings`); paintStatus(); }
  paintStatus();

  // ---- settings form
  const seg = (key, options) => {
    const el = h("div", { class: "seg seg-" + options.length });
    const paint = () => fill(el, options.map(([val, label]) =>
      h("button", { type: "button", class: v[key] === val ? "on" : "", onclick: () => { v[key] = val; paint(); syncSave(); } }, label)));
    paint();
    return el;
  };
  const slider = (key) => {
    const out = h("span", { class: "val" }, v[key] + "%");
    const input = h("input", { type: "range", min: 0, max: 100, step: 1, value: v[key] });
    input.addEventListener("input", () => { v[key] = Number(input.value); out.textContent = input.value + "%"; syncSave(); });
    return h("div", { class: "slider" }, input, out);
  };
  const hours = (key) => {
    const sel = h("select", {}, Array.from({ length: 24 }, (_, i) => h("option", { value: i, selected: v[key] === i }, hourLabel(i))));
    sel.addEventListener("change", () => { v[key] = Number(sel.value); syncSave(); });
    return sel;
  };

  const installed = (data.reported && data.reported.packs) || ["pixel"];
  const packList = [{ id: "pixel", name: "Pixel", license: "Built in", preview: "/packs/pixel.png" }, ...data.packs];
  const packsEl = h("div", { class: "packs" });
  const paintPacks = () => fill(packsEl, packList.map((p) => h("button", {
    type: "button", class: "pack" + (v.pack === p.id ? " on" : ""), onclick: () => { v.pack = p.id; paintPacks(); syncSave(); },
  },
    h("div", { class: "pack-head" }, h("span", { class: "pack-name" }, p.name),
      installed.includes(p.id) ? h("span", { class: "tag" }, "on desk") : p.size ? h("span", { class: "tag" }, Math.round(p.size / 1024) + " KB") : null),
    h("img", { src: p.preview, alt: "", loading: "lazy", onerror: (e) => e.target.remove() }),
    p.license ? h("div", { class: "pack-lic" }, p.license) : null)));
  paintPacks();

  // location: Open-Meteo geocoding, called from the browser
  const placeEl = h("div", { class: "place" });
  const paintPlace = () => fill(placeEl, h("span", { class: "pin" }, "📍"),
    place || (v.lat != null && v.lon != null && (v.lat || v.lon) ? `${v.lat}, ${v.lon}` : "Not set — weather needs a location"));
  paintPlace();
  const q = h("input", { type: "search", placeholder: "Search a city", autocomplete: "off", enterkeyhint: "search" });
  const results = h("div", { class: "list results" });
  results.style.display = "none";
  async function search() {
    const name = q.value.trim();
    if (name.length < 2) return;
    try {
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=" + encodeURIComponent(name));
      const j = await r.json();
      const list = j.results || [];
      results.style.display = "";
      fill(results, list.length ? list.map((c) => {
        const label = [c.name, c.admin1, c.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(", ");
        return h("div", { class: "row tap", onclick: () => {
          v.lat = Math.round(c.latitude * 1e4) / 1e4; v.lon = Math.round(c.longitude * 1e4) / 1e4; place = label; locChanged = true;
          results.style.display = "none"; q.value = ""; paintPlace(); syncSave();
        } }, h("div", { class: "grow" }, h("div", { class: "title" }, label),
          h("div", { class: "sub" }, `${c.latitude.toFixed(2)}, ${c.longitude.toFixed(2)}`)));
      }) : h("div", { class: "empty" }, "No places found."));
    } catch { toast("City search is unavailable right now.", true); }
  }
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });

  const save = h("button", { class: "btn primary block", type: "submit" });
  let saving = false;
  const formState = () => JSON.stringify(SAVE_KEYS.map((k) => v[k]));
  let savedState = formState();
  const changed = () => locChanged || formState() !== savedState;
  function syncSave() {
    save.disabled = saving || !changed();
    save.textContent = saving ? "Saving…" : changed() ? `Save to ${nm()}` : "No changes to save";
  }
  syncSave();
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (saving || !changed()) return;
      const body = Object.fromEntries(SAVE_KEYS.map((k) => [k, v[k]]));
      if (locChanged) Object.assign(body, { lat: v.lat, lon: v.lon, place });
      saving = true; syncSave();
      try {
        data = await api("PUT", `/api/devices/${enc}/settings`, body);
        locChanged = false; savedState = formState(); paintStatus();
        toast(`Saved — ${nm()} updates in a few seconds`);
      } catch (ex) { fail(ex); }
      finally { saving = false; syncSave(); }
    },
  },
    h("h2", {}, "Look"),
    h("div", { class: "card" },
      h("label", { class: "f", style: "margin-top:0" }, "Layout"), seg("layout", [[1, "B · tall clock"], [0, "A · clean"]]),
      h("label", { class: "f" }, "Colours"), seg("soft", [[0, "Vivid"], [1, "Soft"]]),
      h("label", { class: "f" }, "Casper"), seg("casper", [[1, "On"], [0, "Off"]]),
      h("label", { class: "f" }, "Claude face"), seg("face", [[1, "On"], [0, "Off"]]),
      h("label", { class: "f" }, "Time"), seg("h12", [[0, "24 hour"], [1, "12 hour"]]),
      h("label", { class: "f" }, "Temperature"), seg("tf", [[0, "°C"], [1, "°F"]])),
    h("h2", {}, "Reaction style"), packsEl,
    h("h2", {}, "Brightness"),
    h("div", { class: "card" },
      h("label", { class: "f", style: "margin-top:0" }, "Day"), slider("bday"),
      h("label", { class: "f" }, "Night"), slider("bnight"),
      h("div", { class: "two" },
        h("div", {}, h("label", { class: "f" }, "Night starts"), hours("nstart")),
        h("div", {}, h("label", { class: "f" }, "Night ends"), hours("nend")))),
    h("h2", {}, "Location (weather)"),
    h("div", { class: "card" }, placeEl,
      h("div", { class: "inline", style: "margin-top:10px" }, q, h("button", { class: "btn", type: "button", onclick: search }, "Search")),
      results),
    save);

  const wifiEl = wifiCard(enc, () => data);
  const refreshAll = async () => { await refresh(); wifiEl.update(data); };
  fill(main, h("h2", {}, "Status"), status, h("h2", {}, "On your desk"), appDesk(), h("h2", {}, "Notifications"), appNotify(), form, h("h2", {}, "Wi-Fi networks"), wifiEl);
  state.poll = setInterval(() => { if (!document.hidden) refreshAll().catch(() => {}); }, 5000);
}

// ------------------------------------------------------------------ Claude Code
const signal = (rssi) => (rssi >= -60 ? "strong signal" : rssi >= -75 ? "good signal" : "weak signal");

function wifiCard(enc, getData) {
  const el = h("div", { class: "card" });
  let w = getData().wifi || { saved: [], current: "", visible: [], scannedAt: null };
  let pick = "", scanning = false, shownKey = "";
  const online = () => getData().device.online;
  const pass = h("input", { type: "password", placeholder: "Wi-Fi password", autocomplete: "off" });
  const hidden = h("input", { placeholder: "Exact network name", autocapitalize: "none", autocorrect: "off", spellcheck: "false", autocomplete: "off" });
  const hiddenBox = h("details", { class: "more" }, h("summary", {}, "Hidden network?"), hidden);
  hidden.addEventListener("input", () => { if (hidden.value && pick) { pick = ""; paint(); hidden.focus(); } });
  const reload = async () => { try { w = await api("GET", `/api/devices/${enc}/wifi`); } catch { return; } paint(); };
  el.update = (d) => {
    const key = JSON.stringify([d.wifi, d.device.online]);
    if (scanning || key === shownKey) return;
    if (d.wifi) w = d.wifi;
    paint();
  };
  function paint() {
    const data = getData();
    shownKey = JSON.stringify([w, data.device.online]);
    const deskAddr = data.device.ip || (data.device.host ? data.device.host + ".local" : "");
    const inRange = new Set(w.visible.map((v) => v.ssid));
    const newNets = w.visible.filter((v) => !w.saved.includes(v.ssid));
    fill(el,
      h("p", { style: "margin:0" }, "Up to 4 networks (home, hotspot, office…). The desk joins whichever is in range."),
      w.saved.length ? h("div", { class: "list", style: "margin-top:10px" }, w.saved.map((s) => h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, s),
          h("div", { class: "sub" }, s === w.current ? h("span", { class: "ok" }, "connected now")
            : w.scannedAt ? (inRange.has(s) ? "in range" : h("span", { class: "warn" }, "not in range: check the name matches exactly")) : "saved")),
        h("button", { class: "btn small ghost danger", disabled: !online() || s === w.current, onclick: guarded(async () => {
          if (!confirm(`Remove "${s}" from the desk?`)) return;
          try { await api("POST", `/api/devices/${enc}/wifi/remove`, { ssid: s }); toast("Removed"); setTimeout(reload, 1500); } catch (e) { fail(e); }
        }) }, "Remove")))) : h("p", { class: "hint" }, online() ? "Waiting for the desk to report its networks…" : "The desk is offline. Its networks show up here once it's back."),
      h("label", { class: "f" }, "Add a network"),
      h("button", { class: "btn small", disabled: !online() || scanning, onclick: guarded(async () => {
        scanning = true; paint();
        try {
          const before = w.scannedAt || 0;
          await api("POST", `/api/devices/${enc}/wifi/scan`);
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            w = await api("GET", `/api/devices/${enc}/wifi`);
            if ((w.scannedAt || 0) > before) break;
          }
        } catch (e) { fail(e); }
        scanning = false; paint();
      }) }, scanning ? "Looking for networks…" : w.scannedAt ? "Scan again" : "Find networks near the desk"),
      newNets.length ? h("div", { class: "list", style: "margin-top:10px" }, newNets.map((v) => h("div", { class: "row tap" + (pick === v.ssid ? " picked" : ""), onclick: () => { pick = v.ssid; hidden.value = ""; paint(); pass.focus(); } },
        h("div", { class: "grow" }, h("div", { class: "title" }, v.ssid), h("div", { class: "sub" }, `${signal(v.rssi)} · ${v.open ? "no password" : "password"}`)),
        pick === v.ssid ? h("span", { class: "ok" }, "✓") : null))) : null,
      hiddenBox,
      h("form", { onsubmit: guarded(async () => {
        const ssid = hidden.value || pick;
        if (!ssid) return toast("Pick a network first", true);
        try { await api("POST", `/api/devices/${enc}/wifi`, { ssid, pass: pass.value }); pass.value = ""; pick = ""; hidden.value = ""; toast(`Added "${ssid}"`); setTimeout(reload, 1500); }
        catch (e) { fail(e); }
      }) }, pick || hidden.value ? h("label", { class: "f" }, `Password for "${pick || hidden.value}"`) : null, pass,
        h("button", { class: "btn primary block", type: "submit", disabled: !online() }, "Add to the desk")),
      h("p", { class: "hint", style: "margin:10px 0 0" }, "The password goes straight to the desk over its encrypted link. The hub doesn't keep it."),
      deskAddr ? h("p", { class: "hint", style: "margin:4px 0 0" }, "On the same Wi-Fi as the desk? You can also use ",
        h("a", { href: `http://${deskAddr}/wifi`, target: "_blank", rel: "noopener" }, "its own Wi-Fi page"), ".") : null);
  }
  paint();
  return el;
}

const REMIND_OPTS = [[0, "Off"], [5, "5 min before"], [10, "10 min before"], [15, "15 min before"], [30, "30 min before"], [60, "1 hour before"]];
const GH_REASONS = [["review_requested", "Review requests"], ["mention", "Mentions"], ["ci_activity", "Build results (CI)"], ["assign", "Assigned to you"], ["comment", "New comments"]];
const FEED_ERR = {
  unreachable: "can't reach it", dns: "unknown address", https_only: "needs an https:// link", private_address: "private addresses aren't allowed",
  not_a_calendar: "not a calendar link", too_big: "too big", bad_url: "not a valid link",
};
const clockTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const maskSecret = (url) => url.replace(/[^/]+$/, (t) => t.slice(0, 4) + "•".repeat(12));

function appTimers(a) {
  const el = h("div", { class: "card" });
  const label = h("input", { maxlength: 20, placeholder: "Label (optional)" });
  const mins = h("input", { inputmode: "numeric", maxlength: 3, placeholder: "min", style: "max-width:84px" });
  const start = (n) => guarded(async () => {
    try { a.timers = await api("POST", "/api/timers", { minutes: n, label: label.value.trim() }); label.value = ""; mins.value = ""; toast(`Timer set for ${n} min`); paint(); }
    catch (e) { fail(e); }
  });
  function paint() {
    fill(el,
      h("div", { class: "actions" }, [5, 15, 25, 50].map((n) => h("button", { class: "btn small", onclick: start(n) }, `${n} min`))),
      h("div", { class: "inline", style: "margin-top:10px" }, label, mins,
        h("button", { class: "btn small primary", onclick: (e) => { const n = Number(mins.value); if (!(n >= 1 && n <= 720)) return toast("1 to 720 minutes", true); return start(n)(e); } }, "Start")),
      a.timers.length ? h("div", { class: "list", style: "margin-top:12px" }, a.timers.map((t) => h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, t.label), h("div", { class: "sub" }, "ends " + clockTime(t.ends))),
        h("button", { class: "btn small ghost", onclick: guarded(async () => {
          try { await api("DELETE", `/api/timers/${t.id}`); a.timers = a.timers.filter((x) => x.id !== t.id); paint(); } catch (e) { fail(e); }
        }) }, "Cancel")))) : null,
      h("p", { class: "hint", style: "margin:10px 0 0" }, "Your desk counts down under the date and shows a card when time's up."));
  }
  paint();
  return el;
}

const OS_LABEL = { mac: "Mac", windows: "PC", linux: "computer" };
function appComputer(a) {
  const el = h("div", { class: "card" });
  const set = (body) => async (v, cb) => {
    try { a.computer = await api("PATCH", "/api/apps/computer", typeof body === "function" ? body(v) : { [body]: v }); paint(); } catch (e) { fail(e); cb.checked = !v; }
  };
  const note = (t, warn) => t ? h("p", { class: "hint" + (warn ? " warn" : ""), style: "margin:2px 0 8px 28px" }, t) : null;
  function paint() {
    const c = a.computer, mac = c.os === "mac";
    const n = a.calendar.fromComputer;
    const cal = c.cal === "ok" ? `${n} upcoming event${n === 1 ? "" : "s"} from ${c.os === "windows" ? "Outlook" : "your calendars"}.`
      : c.cal === "pending" ? "Waiting for you to click Allow on your Mac."
      : c.os === "windows" ? "Reads Outlook while it's open." : c.os === "linux" ? "Not available on Linux yet." : "Reads every calendar on your Mac (iCloud, Google, Outlook…).";
    fill(el,
      h("p", { class: "hint", style: "margin:0 0 10px" }, c.seen
        ? `Connected to your ${OS_LABEL[c.os] || "computer"} · checked in ${ago(c.seen)}${c.presence ? (c.away ? " · you're away" : " · you're here") : ""}`
        : "Not connected yet: run the command above on your computer."),
      toggle("Now playing", c.music, set("music")),
      note("Spotify, Apple Music, YouTube and more, under the clock (options under Now playing)."),
      toggle("Calendar", c.calendar, set("calendar")),
      c.cal === "not_allowed" ? note("macOS is blocking it: System Settings → Privacy & Security → Calendars → turn on Claude Desk Calendar.", true) : note(cal),
      toggle("Show friends when I'm away", c.presence, set("presence")),
      note("After 10 minutes without keyboard or mouse, or when the computer sleeps."),
      mac || c.apps.length ? [
        h("label", { class: "f" }, "Unread counts"),
        c.apps.length ? c.apps.map((x) => toggle(`${x.app}${x.count ? ` · ${x.count === -1 ? "new" : x.count}` : ""}`, !x.muted, set((v) => ({ mute: { [x.app]: !v } }))))
          : h("p", { class: "hint", style: "margin:0" }, "Apps with a red badge on the Dock show up here (Slack, Mail, Messages, WhatsApp, Discord, Teams…). Your desk gets a card when the number goes up."),
        mac && c.dock !== "ok" ? h("p", { class: "hint" + (c.dock === "not_allowed" ? " warn" : ""), style: "margin:8px 0 0" }, c.dock === "not_allowed"
          ? "WhatsApp and a few other apps need one more permission: System Settings → Privacy & Security → Accessibility → turn on claude-desk-dock."
          : "WhatsApp and a few other apps only show after you run the setup command again and allow Accessibility.") : null,
      ] : null);
  }
  paint();
  return el;
}

function appCalendar(a) {
  const el = h("div", { class: "card" });
  const url = h("input", { placeholder: "https://…/basic.ics", autocomplete: "off", autocapitalize: "none", spellcheck: "false", inputmode: "url" });
  const patch = async (body) => { try { a.calendar = await api("PATCH", "/api/apps/calendar", body); toast("Saved"); } catch (e) { fail(e); } paint(); };
  function paint() {
    const c = a.calendar;
    const remind = h("select", {}, REMIND_OPTS.map(([v, l]) => h("option", { value: v, selected: c.remind === v }, l)));
    remind.addEventListener("change", () => patch({ remind: Number(remind.value) }));
    const showNext = h("input", { type: "checkbox", checked: c.showNext, style: "width:auto" });
    showNext.addEventListener("change", () => patch({ showNext: showNext.checked }));
    const pcCal = c.fromComputer > 0 || a.computer.cal === "ok";
    const g = c.google;
    const google = g.connected ? [
      h("div", { class: "row", style: "padding-top:0" },
        h("div", { class: "grow" }, h("div", { class: "title" }, "Google Calendar"),
          h("div", { class: "sub" }, g.ok === false
            ? h("span", { class: "warn" }, g.error === "reconnect" ? "Google signed you out. Sign in again." : "Can't read it right now; trying again in a few minutes.")
            : `${g.email || "Connected"} · ${g.upcoming} upcoming`)),
        h("button", { class: "btn small ghost", onclick: guarded(async () => {
          if (!confirm("Disconnect Google Calendar?")) return;
          try { await api("DELETE", "/api/apps/google"); a.calendar = (await api("GET", "/api/apps")).calendar; paint(); } catch (e) { fail(e); }
        }) }, "Disconnect")),
      g.error === "reconnect" ? h("a", { class: "btn block", href: "/api/apps/google/connect" }, "Sign in with Google again") : null]
      : g.configured ? [h("a", { class: "btn primary block", href: "/api/apps/google/connect" }, "Sign in with Google"),
        h("p", { class: "hint", style: "margin:6px 0 4px" }, "Read-only: your desk reminds you before meetings and shows the next one under the clock.")] : null;
    const other = pcCal || g.connected || g.configured;
    const linkForm = [
      h("label", { class: "f", style: c.feeds.length || pcCal ? "" : "margin-top:0" }, "Add a calendar (its private iCal link)"),
      h("form", { class: "inline", onsubmit: guarded(async () => {
        const v = url.value.trim();
        if (!v) return;
        try { a.calendar = await api("POST", "/api/apps/calendar/feeds", { url: v }); url.value = ""; toast("Calendar added"); paint(); } catch (e) { fail(e); }
      }) }, url, h("button", { class: "btn primary", type: "submit" }, "Add")),
      h("details", { class: "more" }, h("summary", {}, "Where do I find the link?"),
        h("ul", { class: "help" },
          h("li", {}, h("b", {}, "Google: "), "calendar settings → your calendar → Integrate calendar → Secret address in iCal format."),
          h("li", {}, h("b", {}, "Apple: "), "Calendar app → share the calendar → Public Calendar → copy the link."),
          h("li", {}, h("b", {}, "Outlook: "), "Settings → Calendar → Shared calendars → Publish a calendar → ICS link.")))];
    fill(el,
      google,
      c.fromComputer > 0 ? h("p", { class: "hint", style: g.connected || g.configured ? "margin:10px 0 6px" : "margin:0 0 6px" }, `From your computer: ${c.fromComputer} upcoming event${c.fromComputer === 1 ? "" : "s"}.`) : null,
      c.feeds.length ? h("div", { class: "list" }, c.feeds.map((f, i) => h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, f.label),
          h("div", { class: "sub" }, f.ok === false ? h("span", { class: "warn" }, "Can't read it: " + (FEED_ERR[f.error] || f.error)) : `${f.count} events in the next day and a half`)),
        h("button", { class: "btn small ghost", onclick: guarded(async () => {
          if (!confirm("Remove this calendar?")) return;
          try { a.calendar = await api("DELETE", `/api/apps/calendar/feeds/${i}`); paint(); } catch (e) { fail(e); }
        }) }, "Remove")))) : null,
      other && !c.feeds.length ? h("details", { class: "more" }, h("summary", {}, "Add a calendar link instead"), linkForm) : linkForm,
      c.feeds.length || pcCal || g.connected ? [
        h("label", { class: "f" }, "Remind me"), remind,
        h("label", { class: "check" }, showNext, "Show the next event under the clock"),
        c.upcoming.length ? h("p", { class: "hint", style: "margin:10px 0 0" }, "Coming up: " + c.upcoming.map((e) => `${e.title} ${clockTime(e.start)}`).join(" · ")) : null,
      ] : null);
  }
  paint();
  return el;
}

function appGithub(a) {
  const el = h("div", { class: "card" });
  const tok = h("input", { type: "password", placeholder: "ghp_…", autocomplete: "off" });
  function paint() {
    const g = a.github;
    if (!g.connected) {
      fill(el,
        h("p", { style: "margin:0" }, "A card when someone asks for your review, mentions you, or a build finishes."),
        h("ol", { class: "help" },
          h("li", {}, h("a", { href: "https://github.com/settings/tokens/new?scopes=notifications&description=claude-desk", target: "_blank", rel: "noopener" }, "Create a token"),
            " with only the ", h("b", {}, "notifications"), " box ticked."),
          h("li", {}, "Paste it here. It stays on the hub and is never shown again.")),
        h("form", { class: "inline", onsubmit: guarded(async () => {
          const v = tok.value.trim();
          if (!v) return;
          try { a.github = await api("PUT", "/api/apps/github", { token: v }); tok.value = ""; toast(`Connected as @${a.github.login}`); paint(); } catch (e) { fail(e); }
        }) }, tok, h("button", { class: "btn primary", type: "submit" }, "Connect")));
      return;
    }
    fill(el,
      h("div", { class: "title" }, h("span", { class: "dot" + (g.ok === false ? "" : " on") }), `Connected as @${g.login}`),
      g.ok === false ? h("p", { class: "hint warn" }, g.error === "token" ? "GitHub refused the token. Connect again with a new one." : "Can't reach GitHub right now.") : null,
      h("label", { class: "f" }, "Show a card for"),
      GH_REASONS.map(([k, l]) => {
        const cb = h("input", { type: "checkbox", checked: !!g.reasons[k], style: "width:auto" });
        cb.addEventListener("change", async () => {
          try { a.github = await api("PATCH", "/api/apps/github", { reasons: { [k]: cb.checked } }); } catch (e) { fail(e); cb.checked = !cb.checked; }
        });
        return h("label", { class: "check" }, cb, l);
      }),
      h("button", { class: "btn small ghost danger", style: "margin-top:12px", onclick: guarded(async () => {
        if (!confirm("Disconnect GitHub? The token is deleted from the hub.")) return;
        try { await api("DELETE", "/api/apps/github"); a.github = { connected: false, reasons: g.reasons }; paint(); } catch (e) { fail(e); }
      }) }, "Disconnect"));
  }
  paint();
  return el;
}

function appMarkets(a) {
  const el = h("div", { class: "card" });
  let rows = a.stocks.items.map((x) => ({ ...x }));
  const field = (r, k, ph, mode) => {
    const i = h("input", { value: r[k] ?? "", placeholder: ph, inputmode: mode, autocomplete: "off", spellcheck: "false", autocapitalize: k === "symbol" ? "characters" : "none" });
    i.addEventListener("input", () => { r[k] = i.value; });
    return i;
  };
  const numOrNull = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));
  function paint() {
    const q = a.stocks.quotes;
    fill(el,
      h("p", { style: "margin:0" }, "A card when a price crosses your level, or moves a lot in one day. Stocks like AAPL, crypto like BTC-USD."),
      rows.map((r, i) => {
        const qq = q[String(r.symbol || "").toUpperCase()];
        return h("div", { class: "mkt" },
          h("div", { class: "mkt-row" }, field(r, "symbol", "Symbol", "text"),
            h("button", { class: "btn small ghost", type: "button", "aria-label": "Remove", onclick: () => { rows.splice(i, 1); paint(); } }, "✕")),
          h("div", { class: "mkt-row" }, field(r, "above", "Above", "decimal"), field(r, "below", "Below", "decimal"), field(r, "move", "Move %", "decimal")),
          qq ? h("div", { class: "sub" }, qq.error ? h("span", { class: "warn" }, "No price yet: " + qq.error) : qq.price != null ? `${qq.price} · ${qq.pct >= 0 ? "+" : ""}${qq.pct}% today` : null) : null);
      }),
      h("div", { class: "actions", style: "margin-top:12px" },
        rows.length < 10 ? h("button", { class: "btn small", type: "button", onclick: () => { rows.push({ symbol: "", above: null, below: null, move: null }); paint(); } }, "+ Add symbol") : null,
        h("button", { class: "btn small primary", type: "button", onclick: guarded(async () => {
          const items = rows.filter((r) => String(r.symbol || "").trim()).map((r) => ({ symbol: String(r.symbol).trim(), above: numOrNull(r.above), below: numOrNull(r.below), move: numOrNull(r.move) }));
          try { a.stocks = await api("PUT", "/api/apps/stocks", { items }); rows = a.stocks.items.map((x) => ({ ...x })); toast("Saved"); paint(); } catch (e) { fail(e); }
        }) }, "Save")),
      h("p", { class: "hint", style: "margin:10px 0 0" }, "Checked every 5 minutes, using delayed quotes from Yahoo Finance."));
  }
  paint();
  return el;
}

function appWebhook(a) {
  const url = a.webhook.url;
  const ex = `curl -X POST ${url} -H 'content-type: application/json' -d '{"title":"Build passed","text":"deploy done","icon":"fire"}'`;
  return h("div", { class: "card" },
    h("p", { style: "margin:0" }, "Anything that can call a URL can put a card on your desk: Zapier, n8n, GitHub Actions, Home Assistant, iPhone Shortcuts, your own scripts."),
    h("label", { class: "f" }, "Your private URL"),
    h("div", { class: "codebox" }, h("div", { class: "code" }, maskSecret(url)), h("button", { class: "btn small", onclick: () => copy(url) }, "Copy")),
    h("label", { class: "f" }, "Example"),
    h("div", { class: "codebox" }, h("div", { class: "code" }, maskSecret(url.replace(/\/[^/]+$/, "/")) + "… " + "-d '{\"title\":\"Build passed\",\"text\":\"deploy done\",\"icon\":\"fire\"}'"),
      h("button", { class: "btn small", onclick: () => copy(ex) }, "Copy")),
    h("details", { class: "more" }, h("summary", {}, "What can I send?"),
      h("ul", { class: "help" },
        h("li", {}, h("b", {}, "title"), ", ", h("b", {}, "text"), ": up to 40 and 120 characters. Plain text works too."),
        h("li", {}, h("b", {}, "icon"), ": wave, thumbs, laugh, coffee, fire, heart, hug, kiss, goodnight, missyou."),
        h("li", {}, h("b", {}, "color"), ": teal, orange, green, red, blue, purple, pink, yellow, white or #rrggbb."),
        h("li", {}, h("b", {}, "secs"), ": how long it stays up, 3 to 300 (default 15)."),
        h("li", {}, "It uses the same token as the Claude Code hook: regenerating the token changes this URL."))),
    h("button", { class: "btn block", onclick: guarded(async () => {
      try { const r = await api("POST", "/api/apps/test"); toast(r.devices ? "Sent. Look at your desk." : "No desk paired yet"); } catch (e) { fail(e); }
    }) }, "Send a test card"));
}

const MEDIA_MAX_UPLOAD = 12 * 1024 * 1024;
function pickFile() {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "image/*", style: "display:none" });
    input.addEventListener("change", () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}
async function uploadMedia(file, fit) {
  if (file.size > MEDIA_MAX_UPLOAD) throw new Error(ERRORS.media_input_big);
  let res;
  try {
    res = await fetch("/api/media" + (fit === "contain" ? "?fit=contain" : ""), {
      method: "POST", credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream" }, body: file,
    });
  } catch { throw new Error(ERRORS.network); }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(ERRORS[data.error] || (res.status === 413 ? ERRORS.media_input_big : "Couldn't upload that."));
  return data;
}
const mediaImg = (id, size) => h("img", { class: "thumb", src: `/api/media/${id}/preview`, width: size, height: size, loading: "lazy", alt: "" });

const KEEP_OPTS = [[60, "1 minute"], [600, "10 minutes"], [3600, "1 hour"], [0, "Until I go back"]];
function keepGet() {
  try {
    const v = localStorage.getItem("deskKeep");
    if (v !== null && KEEP_OPTS.some(([k]) => String(k) === v)) return Number(v);
  } catch { return 600; }
  return 600;
}
function keepSet(v) { try { localStorage.setItem("deskKeep", String(v)); } catch { return; } }

function photoPreview(file, onShow) {
  const url = URL.createObjectURL(file);
  let fit = "cover";
  const img = h("img", { src: url, class: "pp-img", alt: "" });
  const seg = h("div", { class: "seg", style: "width:min(92vw,320px)" });
  const paintSeg = () => {
    img.style.objectFit = fit;
    fill(seg, [["cover", "Fill the screen"], ["contain", "Show it all"]].map(([v, l]) =>
      h("button", { type: "button", class: fit === v ? "on" : "", onclick: () => { fit = v; paintSeg(); } }, l)));
  };
  const close = () => { URL.revokeObjectURL(url); dlg.remove(); };
  const dlg = h("div", { class: "draw-overlay" },
    h("div", { class: "draw-head", style: "width:min(92vw,320px)" }, h("b", {}, "Show on your desk"), h("span", { class: "hint", style: "margin:0" }, "This is how it will fit the screen.")),
    h("div", { class: "pp-frame" }, img), seg,
    h("div", { class: "actions", style: "justify-content:center" },
      h("button", { class: "btn small ghost", onclick: close }, "Cancel"),
      h("button", { class: "btn small primary", onclick: () => { close(); onShow(fit); } }, "Show on desk")));
  paintSeg();
  document.body.append(dlg);
}

function appDesk() {
  const el = h("div", { class: "card" });
  const nowEl = h("div", {});
  const status = h("p", { class: "hint", style: "margin:8px 0 0" });
  const keep = h("select", {}, KEEP_OPTS.map(([v, l]) => h("option", { value: v, selected: v === keepGet() }, l)));
  keep.addEventListener("change", () => keepSet(Number(keep.value)));
  let items = [], showing = null, watching = 0;
  const what = (x) => x.kind === "drawing"
    ? (x.live ? "a drawing, live" : x.from === "you" ? "your drawing" : `${x.from}'s drawing`)
    : (x.kind === "gif" ? "a GIF" : "a photo") + (x.from && x.from !== "you" ? ` from ${x.from}` : "");
  const left = (x) => x.until === null ? "until you go back to the clock" : `${Math.max(1, Math.ceil((x.until - Date.now() / 1000) / 60))} min left`;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  function paintNow() {
    if (showing && showing.until !== null && showing.until <= Date.now() / 1000) showing = null;
    fill(nowEl, showing ? h("div", { class: "now-showing" },
      h("div", { class: "grow" }, h("div", { class: "title" }, cap(what(showing))), h("div", { class: "sub" }, left(showing))),
      h("button", { class: "btn small", onclick: guarded(async () => {
        try { await api("POST", "/api/doodles/hide"); showing = null; paintNow(); toast("Back to the clock"); } catch (e) { fail(e); }
      }) }, "Back to clock")) : null);
  }
  async function refreshShowing() {
    try { showing = await api("GET", "/api/showing"); } catch { showing = null; }
    paintNow();
  }
  async function track(id) {
    const mine = ++watching;
    status.textContent = "Sending to your desk…";
    for (let i = 0; i < 90 && mine === watching; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      let d;
      try { d = await api("GET", "/api/media"); } catch { continue; }
      const x = d.deliveries.find((v) => v.media === id);
      if (!x || x.state === "sending") continue;
      status.textContent = x.state === "ok" ? "" : x.error === "space" ? "Your desk ran out of room for it." : "That didn't reach your desk. Try again.";
      return;
    }
    if (mine === watching) status.textContent = "Still sending… long GIFs can take a minute.";
  }
  async function show(it) {
    const secs = Number(keep.value);
    try {
      if (it.type === "drawing") await api("POST", `/api/doodles/${it.id}/show`, { secs });
      else {
        const r = await api("POST", `/api/media/${it.id}/show`, { secs });
        if (!r.devices) { status.textContent = ""; toast("Your desk is offline", true); return; }
        track(it.id);
      }
      refreshShowing();
    } catch (e) { fail(e); }
  }
  async function load() {
    const [d, m] = await Promise.all([api("GET", "/api/doodles/mine").catch(() => []), api("GET", "/api/media").catch(() => ({ items: [] }))]);
    items = [...d.map((x) => ({ type: "drawing", id: x.id, at: x.started, data: x.data })),
      ...m.items.map((x) => ({ type: "media", id: x.id, at: x.created, kind: x.kind }))].sort((a, b) => b.at - a.at);
    paint();
  }
  async function pickPhoto() {
    const f = await pickFile();
    if (!f) return;
    photoPreview(f, async (fit) => {
      fill(status, h("span", { class: "spin" }), " Uploading… this can take a few seconds");
      try { const m = await uploadMedia(f, fit); await load(); await show({ type: "media", id: m.id }); } catch (e) { status.textContent = ""; fail(e); }
    });
  }
  function paint() {
    fill(el, nowEl,
      h("div", { class: "desk-actions" },
        h("button", { class: "btn primary", onclick: () => openDoodle({ to: null, title: "Your canvas", onClose: () => { load(); refreshShowing(); } }) }, "✏️ Draw"),
        h("button", { class: "btn primary", onclick: guarded(pickPhoto) }, "🖼️ Photo or GIF")),
      h("label", { class: "f" }, "Keep it on the desk for"), keep,
      status,
      items.length ? [h("label", { class: "f" }, "Saved · tap one to show it again"),
        h("div", { class: "gallery" }, items.map((it) => h("div", { class: "g-item" },
          h("button", { class: "g-show", "aria-label": "Show on desk", onclick: guarded(() => show(it)) }, it.type === "drawing" ? doodleThumb(it.data, 96) : mediaImg(it.id, 96)),
          it.type === "media" && it.kind === "gif" ? h("span", { class: "g-tag" }, "GIF") : null,
          h("button", { class: "g-del", "aria-label": "Delete", onclick: guarded(async () => {
            if (!confirm("Delete this?")) return;
            try { await api("DELETE", it.type === "drawing" ? `/api/doodles/${it.id}` : `/api/media/${it.id}`); load(); } catch (e) { fail(e); }
          }) }, "✕"))))]
        : h("p", { class: "hint", style: "margin:12px 0 0" }, "Drawings, photos and GIFs you put on your desk are saved here."));
  }
  paint();
  load();
  refreshShowing();
  const timer = setInterval(() => { if (!document.body.contains(el)) clearInterval(timer); else paintNow(); }, 30000);
  return el;
}

function sendMediaSheet(username, displayName, onSent) {
  const grid = h("div", { style: "width:min(92vw,440px);text-align:center" });
  const status = h("p", { class: "hint", style: "margin:0;min-height:20px;text-align:center" });
  let busy = false;
  const close = () => dlg.remove();
  const setBusy = (text) => {
    busy = !!text;
    fill(status, text ? [h("span", { class: "spin" }), " " + text] : null);
    pick.disabled = busy;
    grid.style.opacity = busy ? ".4" : "";
    grid.style.pointerEvents = busy ? "none" : "";
  };
  const send = async (id) => {
    setBusy("Sending to their desk…");
    try {
      const r = await api("POST", `/api/media/${id}/send`, { to: username });
      toast(r.devices ? "Sent to their desk" : "Sent (their desk is offline)");
      close();
      onSent();
    } catch (e) { setBusy(""); fail(e); }
  };
  const pick = h("button", { class: "btn primary", onclick: async () => {
    if (busy) return;
    const f = await pickFile();
    if (!f) return;
    setBusy(`Uploading ${f.type === "image/gif" ? "GIF" : "photo"}… this can take a few seconds`);
    try { const m = await uploadMedia(f, "cover"); await send(m.id); } catch (e) { setBusy(""); fail(e); }
  } }, "Pick a photo or GIF");
  const dlg = h("div", { class: "draw-overlay" },
    h("div", { class: "draw-head" }, h("b", {}, `Send to ${displayName}`), h("span", { class: "hint", style: "margin:0" }, "A photo or GIF on their desk for a minute")),
    pick, status, grid,
    h("button", { class: "btn small ghost", onclick: close }, "Cancel"));
  document.body.append(dlg);
  api("GET", "/api/media").then((d) => fill(grid, d.items.length
    ? [h("p", { class: "hint", style: "margin:0 0 8px" }, "Or one you added before:"),
      h("div", { class: "thumbs", style: "justify-content:center" }, d.items.map((m) => h("button", { class: "thumb-pick", onclick: () => { if (!busy) send(m.id); } }, mediaImg(m.id, 96))))]
    : null)).catch(() => {});
}


const MAIL_PRESETS = [["imap.gmail.com", "Gmail"], ["imap.mail.me.com", "iCloud"], ["imap.mail.yahoo.com", "Yahoo"], ["imap.fastmail.com", "Fastmail"], ["", "Other"]];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const toMin = (v) => { const [hh, mm] = String(v || "").split(":").map(Number); return hh * 60 + (mm || 0); };
const fromMin = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const statusLine = (x, okText) => x.ok === false ? h("p", { class: "hint warn", style: "margin:8px 0 0" }, ERRORS[x.error] || (x.error === "reconnect" ? "Sign-in expired. Connect again." : "Problem: " + x.error))
  : okText ? h("p", { class: "hint", style: "margin:8px 0 0" }, okText) : null;
const toggle = (label, checked, onchange) => {
  const cb = h("input", { type: "checkbox", checked, style: "width:auto" });
  cb.addEventListener("change", () => onchange(cb.checked, cb));
  return h("label", { class: "check" }, cb, label);
};

function appMusic(a) {
  const el = h("div", { class: "card" });
  const lfUser = h("input", { placeholder: "Last.fm username", autocapitalize: "none", autocomplete: "off", spellcheck: "false" });
  const opt = (kind, k) => async (v, cb) => { try { a.music = await api("PATCH", `/api/apps/music/${kind}`, { [k]: v }); } catch (e) { fail(e); cb.checked = !v; } };
  const OS_NAME = { mac: "Mac", windows: "PC", linux: "computer" };
  function paint() {
    const m = a.music, pc = m.computer, sp = m.spotify, lf = m.lastfm;
    pc.on = a.computer.music;
    const opts = (kind, x) => [toggle("Show what's playing under the clock", x.clock, opt(kind, "clock")), toggle("Show a card when the song changes", x.cards, opt(kind, "cards"))];
    const off = (kind) => h("button", { class: "btn small ghost danger", style: "margin-top:10px", onclick: guarded(async () => {
      if (!confirm("Disconnect?")) return;
      try { await api("DELETE", `/api/apps/${kind}`); a = { ...a, music: (await api("GET", "/api/apps")).music }; paint(); } catch (e) { fail(e); }
    }) }, "Disconnect");
    const sep = () => h("div", { style: "border-top:1px solid var(--line);margin:14px 0 10px" });
    const where = `your ${OS_NAME[pc.os] || "computer"}`;
    const warn = (t) => h("p", { class: "hint warn", style: "margin:8px 0 0" }, t);
    const computer = !pc.on ? h("p", { class: "hint", style: "margin:4px 0 0" }, "Off. Turn it on under Your computer.")
      : pc.seen ? [
        h("p", { class: "hint", style: "margin:4px 0 0" }, m.playing?.src === "computer" && pc.app ? `Playing in ${pc.app} on ${where}` : `Connected to ${where} · checked in ${ago(pc.seen)}`),
        pc.error === "not_allowed" ? warn("macOS is blocking it: open System Settings → Privacy & Security → Automation, find Python and turn on Spotify and Music.") : null,
        pc.error === "no_playerctl" ? warn("Install playerctl so it can read your player (e.g. sudo apt install playerctl).") : null,
        opts("computer", pc)]
      : [h("p", { class: "hint", style: "margin:4px 0 8px" }, "No account needed: it comes with the one-line setup above (Set up your computer). It reads Spotify, Apple Music and YouTube or other music in your browser. Set it up before today? Run it again."),
        h("button", { class: "btn block", onclick: () => document.getElementById("app-claude")?.scrollIntoView({ behavior: "smooth" }) }, "Show the install command")];
    const phone = lf.connected ? [h("p", { class: "hint", style: "margin:4px 0 0" }, `Following last.fm/user/${lf.user}`), statusLine(lf), opts("lastfm", lf), off("lastfm")]
      : [
        h("p", { class: "hint", style: "margin:4px 0 8px" }, "Through Last.fm, a free service that keeps a list of what you play on any device. Link your music app to it once:"),
        h("ul", { class: "hint steps" },
          h("li", {}, h("b", {}, "Spotify: "), h("a", { href: "https://www.last.fm/settings/applications", target: "_blank", rel: "noopener" }, "last.fm → Settings → Applications"), " → Spotify → Connect"),
          h("li", {}, h("b", {}, "YouTube Music: "), "Pano Scrobbler on Android, or the Web Scrobbler browser extension"),
          h("li", {}, h("b", {}, "Deezer, Tidal: "), "turn on Last.fm in the app's settings"),
          h("li", {}, h("b", {}, "Apple Music: "), "a scrobbler app")),
        lf.signin ? h("a", { class: "btn block", href: "/api/apps/lastfm/connect" }, "Sign in with Last.fm") : null,
        h("details", { class: "more", open: !lf.signin }, h("summary", {}, lf.signin ? "Or type your Last.fm username" : "Your Last.fm username"),
          h("form", { class: "inline", style: "margin-top:8px", onsubmit: guarded(async () => {
            if (!lfUser.value.trim()) return;
            try { a.music = await api("PUT", "/api/apps/lastfm", { user: lfUser.value.trim() }); lfUser.value = ""; toast("Last.fm connected"); paint(); } catch (e) { fail(e); }
          }) }, lfUser, h("button", { class: "btn", type: "submit" }, "Connect")))];
    fill(el,
      m.playing ? h("div", { class: "title", style: "margin-bottom:10px" }, "♫ ", m.playing.title, m.playing.artist ? h("span", { class: "sub" }, " · " + m.playing.artist) : null) : null,
      h("b", {}, "From your computer"), computer,
      lf.configured || lf.connected ? [sep(), h("b", {}, "On your phone or a speaker"), phone] : null,
      sp.connected ? [sep(), h("b", {}, "Spotify account"), h("p", { class: "hint", style: "margin:4px 0 0" }, `Connected as ${sp.name}`), statusLine(sp), opts("spotify", sp), off("spotify")]
        : sp.configured ? [sep(), h("b", {}, "Spotify account"), h("p", { class: "hint", style: "margin:4px 0 8px" }, "Only for accounts this hub's owner has added."),
          h("a", { class: "btn block", href: "/api/apps/spotify/connect" }, "Connect Spotify")] : null);
  }
  paint();
  return el;
}

function appReminders(a) {
  const el = h("div", { class: "card" });
  let kind = "every";
  const label = h("input", { maxlength: 24, placeholder: "Drink water" });
  const everyLabel = (n) => n < 60 ? `every ${n} min` : `every ${n / 60} h`.replace(".5 h", "½ h");
  const every = h("select", {}, [15, 30, 45, 60, 90, 120, 180, 240].map((n) => h("option", { value: n, selected: n === 60 }, everyLabel(n))));
  const start = h("input", { type: "time", value: "09:00" }), end = h("input", { type: "time", value: "18:00" }), at = h("input", { type: "time", value: "09:00" });
  const days = DAY_NAMES.map((d, i) => { const cb = h("input", { type: "checkbox", checked: i < 5, style: "width:auto" }); return { d, cb }; });
  const describe = (r) => {
    const ds = DAY_NAMES.filter((_, i) => r.days & (1 << i));
    const when = r.days === 127 ? "every day" : r.days === 31 ? "weekdays" : r.days === 96 ? "weekends" : ds.join(", ");
    return r.kind === "at" ? `${fromMin(r.at)} · ${when}` : `${everyLabel(r.every)}, ${fromMin(r.start)}–${fromMin(r.end)} · ${when}`;
  };
  function paint() {
    fill(el,
      a.reminders.length ? h("div", { class: "list", style: "margin-bottom:12px" }, a.reminders.map((r) => h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, r.label), h("div", { class: "sub" }, describe(r))),
        h("button", { class: "btn small ghost", onclick: guarded(async () => {
          try { await api("DELETE", `/api/reminders/${r.id}`); a.reminders = a.reminders.filter((x) => x.id !== r.id); paint(); } catch (e) { fail(e); }
        }) }, "Remove")))) : null,
      h("div", { class: "seg seg-2" }, [["every", "Repeat"], ["at", "At a time"]].map(([k, l]) => h("button", { type: "button", class: kind === k ? "on" : "", onclick: () => { kind = k; paint(); } }, l))),
      h("label", { class: "f" }, "What"), label,
      kind === "every" ? [h("label", { class: "f" }, "How often"), every, h("div", { class: "two" }, h("div", {}, h("label", { class: "f" }, "From"), start), h("div", {}, h("label", { class: "f" }, "Until"), end))]
        : [h("label", { class: "f" }, "Time"), at],
      h("label", { class: "f" }, "Days"),
      h("div", { class: "days" }, days.map(({ d, cb }) => h("label", { class: "day" }, cb, d))),
      h("button", { class: "btn primary block", onclick: guarded(async () => {
        const mask = days.reduce((m, { cb }, i) => m | (cb.checked ? 1 << i : 0), 0);
        const b = kind === "at" ? { kind, label: label.value, at: toMin(at.value), days: mask }
          : { kind, label: label.value, every: Number(every.value), start: toMin(start.value), end: toMin(end.value), days: mask };
        try { a.reminders = await api("POST", "/api/reminders", b); label.value = ""; toast("Reminder added"); paint(); } catch (e) { fail(e); }
      }) }, "Add reminder"));
  }
  paint();
  return el;
}

function appRain(a) {
  const el = h("div", { class: "card" });
  function paint() {
    const r = a.rain;
    fill(el,
      h("p", { style: "margin:0" }, "A card about 30 minutes before rain starts where your desk is."),
      !r.hasLocation ? h("p", { class: "hint warn" }, ERRORS.no_location) : null,
      toggle("Rain alerts", r.on, async (v, cb) => { try { a.rain = await api("PUT", "/api/apps/rain", { on: v }); paint(); } catch (e) { fail(e); cb.checked = !v; } }),
      r.on ? statusLine(r, "On. Checked every 15 minutes.") : null);
  }
  paint();
  return el;
}

function appEmail(a) {
  const el = h("div", { class: "card" });
  const preset = h("select", {}, MAIL_PRESETS.map(([v, l]) => h("option", { value: v }, l)));
  const host = h("input", { placeholder: "imap.example.com", autocapitalize: "none", spellcheck: "false" });
  const user = h("input", { placeholder: "you@example.com", type: "email", autocapitalize: "none", autocomplete: "off" });
  const pass = h("input", { placeholder: "App password", type: "password", autocomplete: "off" });
  const subjects = h("input", { type: "checkbox", checked: true, style: "width:auto" });
  preset.addEventListener("change", () => { host.value = preset.value; host.parentElement.style.display = preset.value ? "none" : ""; });
  host.value = MAIL_PRESETS[0][0];
  function paint() {
    const e = a.email;
    if (e.connected) {
      fill(el, h("div", { class: "title" }, h("span", { class: "dot" + (e.ok === false ? "" : " on") }), e.user),
        h("p", { class: "hint", style: "margin:4px 0 0" }, `${e.host}${e.unseen != null ? ` · ${e.unseen} unread` : ""}`), statusLine(e),
        toggle("Show the subject on the desk", e.subjects, async (v, cb) => { try { a.email = await api("PATCH", "/api/apps/email", { subjects: v }); } catch (err) { fail(err); cb.checked = !v; } }),
        h("button", { class: "btn small ghost danger", style: "margin-top:10px", onclick: guarded(async () => {
          if (!confirm("Disconnect email? The app password is deleted from the hub.")) return;
          try { await api("DELETE", "/api/apps/email"); a.email = { connected: false }; paint(); } catch (err) { fail(err); }
        }) }, "Disconnect"));
      return;
    }
    fill(el,
      h("p", { style: "margin:0" }, "A card when new mail arrives. Uses an app password (not your real one), so you can revoke it any time."),
      h("details", { class: "more" }, h("summary", {}, "How do I get an app password?"),
        h("ul", { class: "help" },
          h("li", {}, h("b", {}, "Gmail: "), "turn on 2-Step Verification, then myaccount.google.com/apppasswords."),
          h("li", {}, h("b", {}, "iCloud: "), "account.apple.com → Sign-In and Security → App-Specific Passwords."),
          h("li", {}, h("b", {}, "Yahoo: "), "Account security → Generate app password."),
          h("li", {}, h("b", {}, "Outlook / Hotmail: "), "not supported (Microsoft turned off app passwords for mail)."))),
      h("label", { class: "f" }, "Provider"), preset,
      h("div", { style: "display:none" }, h("label", { class: "f" }, "IMAP server"), host),
      h("label", { class: "f" }, "Email address"), user,
      h("label", { class: "f" }, "App password"), pass,
      h("label", { class: "check" }, subjects, "Show the subject on the desk"),
      h("button", { class: "btn primary block", onclick: guarded(async () => {
        try { a.email = await api("PUT", "/api/apps/email", { host: host.value.trim(), user: user.value.trim(), pass: pass.value, subjects: subjects.checked }); pass.value = ""; toast("Email connected"); paint(); }
        catch (err) { fail(err); }
      }) }, "Connect"));
  }
  paint();
  return el;
}

function appSlack(a) {
  const el = h("div", { class: "card" });
  const s = a.slack;
  if (s.connected) {
    fill(el, h("div", { class: "title" }, h("span", { class: "dot" + (s.ok === false ? "" : " on") }), `Connected to ${s.team || "Slack"}`),
      statusLine(s, "A card when someone @mentions you. Checked every minute."),
      h("button", { class: "btn small ghost danger", style: "margin-top:10px", onclick: guarded(async () => {
        if (!confirm("Disconnect Slack?")) return;
        try { await api("DELETE", "/api/apps/slack"); a.slack = { ...s, connected: false }; el.replaceWith(appSlack(a)); } catch (e) { fail(e); }
      }) }, "Disconnect"));
  } else {
    fill(el, h("p", { style: "margin:0" }, "A card when someone @mentions you in Slack."),
      s.configured ? h("a", { class: "btn block", href: "/api/apps/slack/connect" }, "Connect Slack") : h("p", { class: "hint" }, "Not set up on this hub yet."));
  }
  return el;
}

async function viewApps() {
  shell("Apps", h("div", { class: "empty" }, "Loading…"));
  const [{ token, hub }, a] = await Promise.all([api("GET", "/api/token"), api("GET", "/api/apps"), loadMe()]);
  shell("Apps", []); // repaint header pill with fresh status
  const m = document.querySelector("main");
  const v = state.me.claude || { s: "idle" };
  const icons = { idle: "😴", working: "⚙️", needs: "✋", done: "✅" };
  const words = { idle: "Idle", working: "Working", needs: "Needs you", done: "Done" };
  let shown = false;
  const tokenEl = h("div", { class: "code" }, "•".repeat(24));
  const unix = `curl -fsSL ${hub}/install.sh | bash -s -- ${token}`;
  const win = `$env:CLAUDE_DESK_TOKEN='${token}'; irm ${hub}/install.ps1 | iex`;
  const cmd = (label, text) => [h("label", { class: "f" }, label),
    h("div", { class: "codebox" }, h("div", { class: "code" }, text), h("button", { class: "btn small", onclick: () => copy(text) }, "Copy"))];
  fill(m,
    h("nav", { class: "chips" }, [["Claude Code", "app-claude"], ["Computer", "app-computer"], ["Music", "app-music"], ["Timer", "app-timer"], ["Reminders", "app-reminders"], ["Rain", "app-rain"], ["Calendar", "app-calendar"], ["GitHub", "app-github"],
      ["Markets", "app-markets"], ["Email", "app-email"], ["Slack", "app-slack"], ["Webhook", "app-webhook"]].map(([l, id]) =>
      h("button", { type: "button", class: "chip", onclick: () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }) }, l))),
    h("h2", { id: "app-claude" }, "Claude Code"),
    h("div", { class: "card status-card" }, h("span", { class: "big" }, icons[v.s] || "•"),
      h("div", { class: "grow" }, h("div", { class: "title" }, words[v.s] || v.s),
        h("div", { class: "sub" }, [v.p, v.d].filter(Boolean).join(" — ") || "Across all your Claude Code sessions"))),
    h("h2", {}, "Set up your computer"),
    h("div", { class: "card" },
      h("p", { class: "hint", style: "margin-top:0" }, "Run this once on each computer you use. It connects Claude Code to your desk, and your computer starts feeding the desk: what's playing, your calendar, unread counts and when you're away. Only titles and counts leave it, never your code, messages or files. Turn each part on or off below."),
      cmd("macOS / Linux (Terminal)", unix),
      cmd("Windows (PowerShell)", win)),
    h("h2", {}, "Hook token"),
    h("div", { class: "card" },
      h("div", { class: "codebox", style: "margin-top:0" }, tokenEl,
        h("button", { class: "btn small", onclick: (e) => { shown = !shown; tokenEl.textContent = shown ? token : "•".repeat(24); e.target.textContent = shown ? "Hide" : "Show"; } }, "Show"),
        h("button", { class: "btn small", onclick: () => copy(token) }, "Copy")),
      h("button", {
        class: "btn block danger", onclick: guarded(async () => {
          if (!confirm("Regenerate the token? Computers using the old one stop updating until you re-run the install command.")) return;
          try { await api("POST", "/api/token/regenerate"); toast("New token created"); viewApps(); } catch (e) { fail(e); }
        }),
      }, "Regenerate token")),
    h("h2", { id: "app-computer" }, "Your computer"), appComputer(a),
    h("h2", { id: "app-music" }, "Now playing"), appMusic(a),
    h("h2", { id: "app-timer" }, "Timer"), appTimers(a),
    h("h2", { id: "app-reminders" }, "Reminders"), appReminders(a),
    h("h2", { id: "app-rain" }, "Rain alerts"), appRain(a),
    h("h2", { id: "app-calendar" }, "Calendar"), appCalendar(a),
    h("h2", { id: "app-github" }, "GitHub"), appGithub(a),
    h("h2", { id: "app-markets" }, "Stocks & crypto"), appMarkets(a),
    h("h2", { id: "app-email" }, "Email"), appEmail(a),
    h("h2", { id: "app-slack" }, "Slack"), appSlack(a),
    h("h2", { id: "app-webhook" }, "Webhook"), appWebhook(a));
  const ok = state.query && state.query.get("ok"), err = state.query && state.query.get("err");
  if (ok || err) {
    history.replaceState(null, "", "#/apps");
    if (ok) toast(`${{ spotify: "Spotify", slack: "Slack", lastfm: "Last.fm", google: "Google Calendar" }[ok] || ok} connected`);
    else toast(ERRORS[err] || "Sign-in failed", true);
    const kind = ok || String(err).split("_")[0];
    document.getElementById(kind === "slack" ? "app-slack" : kind === "google" ? "app-calendar" : "app-music")?.scrollIntoView();
  }
}

// ------------------------------------------------------------------ settings
async function viewSettings() {
  await loadMe();
  const main = shell("Settings", []);
  const name = h("input", { maxlength: 20, value: state.me.displayName });
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = []; }
  if (!zones.includes("UTC")) zones.unshift("UTC");
  if (!zones.includes(state.me.tz)) zones.unshift(state.me.tz);
  const tz = h("select", {}, zones.map((z) => h("option", { value: z, selected: z === state.me.tz }, z.replace(/_/g, " "))));
  fill(main, 
    h("h2", {}, "Profile"),
    h("form", {
      class: "card", onsubmit: guarded(async () => {
        try { state.me = { ...state.me, ...(await api("PATCH", "/api/me", { displayName: name.value.trim(), tz: tz.value })) }; toast("Saved"); }
        catch (ex) { fail(ex); }
      }),
    },
      h("label", { class: "f", style: "margin-top:0" }, "Username"), h("div", { class: "code", style: "user-select:text;color:var(--text)" }, "@" + state.me.username),
      h("label", { class: "f" }, "Display name (shown on friends' desks)"), name,
      h("label", { class: "f" }, "Timezone (for times on your desk)"),
      h("div", { class: "inline" }, tz, h("button", { class: "btn small", type: "button", onclick: () => { tz.value = browserTz(); } }, "Detect")),
      h("button", { class: "btn primary block", type: "submit" }, "Save")),
    h("h2", {}, "Account"),
    h("div", { class: "card" },
      h("button", { class: "btn block danger", style: "margin-top:0", onclick: async () => { await api("POST", "/api/logout").catch(() => {}); state.me = null; go("#/login"); } }, "Sign out")),
    h("p", { class: "hint", style: "text-align:center;margin-top:24px" }, "claude-desk hub"));
}

// ------------------------------------------------------------------ data + router
async function loadMe() { state.me = await api("GET", "/api/me"); return state.me; }
async function loadFriends() { state.friends = await api("GET", "/api/friends"); return state.friends; }

async function render() {
  clearInterval(state.poll); state.poll = null;
  document.getElementById("toast").className = "";
  const [hash, query] = (location.hash || "#/home").split("?");
  state.route = hash.slice(1);
  state.query = new URLSearchParams(query || "");
  try {
    if (!state.config) state.config = await api("GET", "/api/config").catch(() => ({}));
    if (hash === "#/install") {
      if (!state.me) await loadMe().catch(() => null);
      return await viewInstall();
    }
    if (!state.me && hash !== "#/login") {
      try { await loadMe(); } catch { return go("#/login"); }
    }
    if (hash === "#/login") return state.me ? go("#/home") : viewLogin();
    if (!state.friends.length && hash !== "#/friends") loadFriends().catch(() => {});
    const chat = hash.match(/^#\/chat\/([a-z0-9_]{1,20})$/);
    if (chat) return await viewChat(chat[1]);
    const dev = hash.match(/^#\/device\/(esp-[0-9a-f]{1,8})$/);
    if (dev) return await viewDevice(dev[1]);
    switch (hash) {
      case "#/friends": return await viewFriends();
      case "#/devices": return await viewDevices();
      case "#/devices/add": state.devices = await api("GET", "/api/devices"); return viewAddDevice();
      case "#/apps": case "#/claude": return await viewApps();
      case "#/settings": return await viewSettings();
      default: return await viewHome();
    }
  } catch (e) { if (e.status !== 401) fail(e); }
}

window.addEventListener("hashchange", render);
render();
