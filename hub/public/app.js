"use strict";
// claude-desk web app: vanilla JS, no build step. All user data goes through textContent (h()).

const FRIEND_REACTIONS = [["wave", "👋"], ["thumbs", "👍"], ["laugh", "😂"], ["coffee", "☕"], ["fire", "🔥"]];
const PARTNER_REACTIONS = [["heart", "❤️"], ["hug", "🤗"], ["kiss", "😘"], ["goodnight", "🌙"], ["missyou", "🥺"]];
const EMOJI = Object.fromEntries([...FRIEND_REACTIONS, ...PARTNER_REACTIONS]);
const MSG_MAX = 100;
const ERRORS = {
  credentials: "Wrong username or password.", invite: "That invite code isn't right.", taken: "That username is taken.",
  username: "Username: 3-20 characters, a-z 0-9 _", password: "Password must be at least 8 characters.",
  rate_limited: "Slow down a little and try again in a minute.", no_such_user: "No user with that name.",
  self: "That's you.", invalid_code: "No device is showing that code. Check the screen and try again.",
  code: "The pair code has 6 digits.", not_friends: "You're not friends yet.", partner_only: "That reaction is for partners.",
  too_long: "Messages are up to 100 characters.", empty: "Type something first.", auth: "Please sign in again.",
  tz: "Unknown timezone.", network: "Can't reach the hub.",
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
  if (res.status === 401 && url !== "/api/login") { state.me = null; if (!location.hash.startsWith("#/login")) go("#/login"); }
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
const TABS = [["#/home", "💬", "Home"], ["#/friends", "👥", "Friends"], ["#/devices", "🖥️", "Devices"], ["#/claude", "✳️", "Claude"], ["#/settings", "⚙️", "Settings"]];

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
    claudePill());
  const nav = h("nav", { class: "tabs" }, h("div", { class: "inner" }, TABS.map(([href, ic, label]) =>
    h("a", { href, class: state.route.startsWith(href.slice(1)) || (href === "#/home" && state.route.startsWith("/chat")) ? "on" : "" },
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
    form));
}

// ------------------------------------------------------------------ home + chat
async function viewHome() {
  const main = shell("claude-desk", h("div", { class: "empty" }, "Loading…"));
  await loadFriends();
  const friends = state.friends.filter((f) => f.rel);
  const list = friends.length
    ? h("div", { class: "list" }, friends.map((f) => h("div", { class: "row tap", onclick: () => go("#/chat/" + f.username) },
        h("div", { class: "avatar" + (f.rel === "partner" ? " partner" : "") }, f.rel === "partner" ? "❤" : f.displayName.slice(0, 1)),
        h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName),
          h("div", { class: "sub" }, "@" + f.username + (f.rel === "partner" ? " · partner" : ""))),
        h("span", { class: "chev" }, "›"))))
    : h("div", { class: "card empty" }, "No friends yet. ", h("a", { href: "#/friends" }, "Add someone"), " to send messages to their desk.");
  fill(main, h("h2", {}, "Send to a desk"), list,
    state.friends.some((f) => f.pendingFrom === "them") ? h("p", { class: "hint" }, h("a", { href: "#/friends" }, "You have friend requests waiting.")) : null);
}

async function viewChat(username) {
  if (!state.friends.length) await loadFriends().catch(() => {});
  const fr = state.friends.find((f) => f.username === username);
  const partner = fr && fr.rel === "partner";
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
  const reactBtn = ([key, emoji], isPartner) => h("button", {
    type: "button", class: isPartner ? "partner" : "", title: key, "aria-label": key,
    onclick: () => send({ kind: "reaction", reaction: key }),
  }, emoji);
  const composer = h("div", { class: "composer" },
    h("div", { class: "reacts" }, FRIEND_REACTIONS.map((r) => reactBtn(r, false)),
      partner ? [h("span", { class: "sep" }), PARTNER_REACTIONS.map((r) => reactBtn(r, true))] : null),
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
    msgs.replaceChildren(...(list.length ? list.map((m) => m.kind === "reaction"
      ? h("div", { class: "bubble react" + (m.mine ? " mine" : ""), title: m.reaction }, EMOJI[m.reaction] || m.reaction, h("span", { class: "meta" }, clock(m.t)))
      : h("div", { class: "bubble" + (m.mine ? " mine" : "") }, m.text, h("span", { class: "meta" }, clock(m.t))))
      : [h("div", { class: "empty" }, "Say hi. It pops up on their desk.")]));
    if (atBottom || first) window.scrollTo(0, document.body.scrollHeight);
    first = false;
  }

  shell(fr ? fr.displayName : "@" + username, [msgs, fr && fr.rel ? composer : h("div", { class: "empty" }, "You're not friends with @" + username + ".")], { back: "#/home", chat: true });
  await refresh().catch(fail);
  state.poll = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 4000);
}

// ------------------------------------------------------------------ friends
async function viewFriends() {
  const main = shell("Friends", h("div", { class: "empty" }, "Loading…"));
  await loadFriends();
  const username = h("input", { placeholder: "username", autocapitalize: "none", spellcheck: "false", maxlength: 20 });
  const rel = h("select", {}, h("option", { value: "friend" }, "Friend"), h("option", { value: "partner" }, "Partner"));
  const add = h("form", {
    class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const u = username.value.trim().toLowerCase().replace(/^@/, "");
      if (!u) return;
      try {
        const r = await api("POST", "/api/friends", { username: u, rel: rel.value });
        toast(r.rel === rel.value && !r.pendingRel ? "You're connected" : "Request sent");
        viewFriends();
      } catch (ex) { fail(ex); }
    },
  }, h("div", { class: "inline" }, username, rel, h("button", { class: "btn primary", type: "submit" }, "Add")),
    h("p", { class: "hint", style: "margin-bottom:0" }, "Partners can also send each other ❤️ 🤗 😘 🌙 🥺."));

  const act = (method, url, msg) => async () => { try { await api(method, url); if (msg) toast(msg); viewFriends(); } catch (e) { fail(e); } };
  const incoming = state.friends.filter((f) => f.pendingFrom === "them");
  const outgoing = state.friends.filter((f) => f.pendingFrom === "me");
  const current = state.friends.filter((f) => f.rel);
  const enc = encodeURIComponent;
  const relTag = (r) => h("span", { class: "tag" + (r === "partner" ? " partner" : "") }, r);

  fill(main, 
    h("h2", {}, "Add"), add,
    incoming.length ? [h("h2", {}, "Requests"), h("div", { class: "list" }, incoming.map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName),
        h("div", { class: "sub" }, "@" + f.username + (f.rel ? ` · wants to change ${f.rel} → ${f.pendingRel}` : ` · wants to be your ${f.pendingRel}`))),
      h("div", { class: "actions" },
        h("button", { class: "btn small primary", onclick: act("POST", `/api/friends/${enc(f.username)}/accept`, "Accepted") }, "Accept"),
        h("button", { class: "btn small ghost", onclick: act("POST", `/api/friends/${enc(f.username)}/decline`) }, "Decline")))))] : null,
    h("h2", {}, "Your people"),
    current.length ? h("div", { class: "list" }, current.map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" + (f.rel === "partner" ? " partner" : "") }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName, relTag(f.rel)),
        h("div", { class: "sub" }, "@" + f.username + (f.pendingFrom === "me" ? ` · asked to change to ${f.pendingRel}` : ""))),
      h("div", { class: "actions" },
        h("button", { class: "btn small ghost", "aria-label": "Options", onclick: () => friendMenu(f) }, "•••")))))
      : h("div", { class: "card empty" }, "Nobody yet."),
    outgoing.filter((f) => !f.rel).length ? [h("h2", {}, "Sent"), h("div", { class: "list" }, outgoing.filter((f) => !f.rel).map((f) => h("div", { class: "row" },
      h("div", { class: "avatar" }, f.displayName.slice(0, 1)),
      h("div", { class: "grow" }, h("div", { class: "title" }, f.displayName), h("div", { class: "sub" }, `@${f.username} · ${f.pendingRel} request pending`)),
      h("button", { class: "btn small ghost", onclick: act("POST", `/api/friends/${enc(f.username)}/decline`, "Cancelled") }, "Cancel"))))] : null,
  );

}

function friendMenu(f) {
  const enc = encodeURIComponent(f.username);
  const other = f.rel === "partner" ? "friend" : "partner";
  const close = () => dlg.remove();
  const doIt = (fn) => async () => { close(); try { await fn(); viewFriends(); } catch (e) { fail(e); } };
  const dlg = h("div", { style: "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:20;display:flex;align-items:flex-end;justify-content:center", onclick: (e) => { if (e.target === dlg) close(); } },
    h("div", { class: "card", style: "width:100%;max-width:560px;border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom))" },
      h("div", { class: "title", style: "font-weight:600;margin-bottom:12px" }, f.displayName + " · @" + f.username),
      f.pendingFrom === "me"
        ? h("button", { class: "btn block", style: "margin-top:0", onclick: doIt(() => api("POST", `/api/friends/${enc}/decline`)) }, `Cancel ${f.pendingRel} request`)
        : h("button", { class: "btn block", style: "margin-top:0", onclick: doIt(async () => { await api("POST", "/api/friends", { username: f.username, rel: other }); toast("Request sent"); }) },
            `Ask to be ${other === "partner" ? "partners" : "just friends"}`),
      h("button", { class: "btn block danger", style: "margin-top:8px", onclick: doIt(async () => {
        if (!confirm(`Remove @${f.username}? You won't be able to message each other.`)) return;
        await api("DELETE", `/api/friends/${enc}`); toast("Removed");
      }) }, "Remove"),
      h("button", { class: "btn block ghost", style: "margin-top:8px", onclick: close }, "Close")));
  document.body.append(dlg);
}

// ------------------------------------------------------------------ devices
async function viewDevices() {
  const main = shell("Devices", h("div", { class: "empty" }, "Loading…"));
  state.devices = await api("GET", "/api/devices");
  const code = h("input", { inputmode: "numeric", pattern: "[0-9 ]*", maxlength: 7, placeholder: "482913", autocomplete: "one-time-code" });
  const name = h("input", { maxlength: 20, placeholder: "Desk", value: state.devices.length ? "" : "Desk" });
  const pair = h("form", {
    class: "card", onsubmit: async (e) => {
      e.preventDefault();
      try {
        const d = await api("POST", "/api/devices/pair", { code: code.value.replace(/\s/g, ""), name: name.value.trim() || "Desk" });
        toast("Paired! Your desk will switch over in a moment."); go("#/device/" + d.chip);
      } catch (ex) { fail(ex); }
    },
  }, h("label", { class: "f", style: "margin-top:0" }, "Pair code shown on the device"), code,
    h("label", { class: "f" }, "Name"), name, h("button", { class: "btn primary block", type: "submit" }, "Pair device"));

  const list = state.devices.length
    ? h("div", { class: "list" }, state.devices.map((d) => h("div", { class: "row tap", onclick: () => go("#/device/" + d.chip) },
        h("div", { class: "grow" },
          h("div", { class: "title" }, h("span", { class: "dot" + (d.online ? " on" : "") }), d.name || "Desk"),
          h("div", { class: "sub" }, [d.online ? "online" : "last seen " + ago(d.lastSeen), d.fw ? "fw " + d.fw : null].filter(Boolean).join(" · "))),
        h("span", { class: "chev" }, "›"))))
    : h("div", { class: "card empty" }, "No devices yet.");
  const pairBlock = [h("h2", {}, "Pair a desk"), pair,
    h("p", { class: "hint" }, "Power on your GeekMagic with the claude-desk firmware. It shows a 6-digit code until it's paired.")];
  fill(main, state.devices.length ? [h("h2", {}, "Your desks"), list, pairBlock] : [pairBlock, h("h2", {}, "Your desks"), list]);
}

// ------------------------------------------------------------------ one desk: status + remote settings
const DEFAULT_SETTINGS = { layout: 1, soft: 0, casper: 1, pack: "pixel", bday: 25, bnight: 10, nstart: 22, nend: 7 };
const hourLabel = (n) => String(n).padStart(2, "0") + ":00";

async function viewDevice(chip) {
  const enc = encodeURIComponent(chip);
  shell("Desk", h("div", { class: "empty" }, "Loading…"), { back: "#/devices" });
  let data;
  try { data = await api("GET", `/api/devices/${enc}/settings`); }
  catch (e) { if (e.status === 404) { toast("That desk isn't yours (or was forgotten).", true); return go("#/devices"); } throw e; }

  const v = { ...DEFAULT_SETTINGS, ...(data.reported || {}), ...(data.settings || {}) };
  let place = data.place || null, locChanged = false;
  const main = shell(data.device.name || "Desk", [], { back: "#/devices" });

  // ---- status card (refreshed by polling, form below is left alone)
  const status = h("div", { class: "card" });
  function paintStatus() {
    const d = data.device, fw = data.firmware;
    const rep = data.reported, want = data.settings;
    const sync = !want ? null
      : rep && rep.rev >= want.rev ? h("span", { class: "ok" }, "✓ Desk is using your latest settings")
      : h("span", { class: "warn" }, d.online ? "Sending settings to the desk…" : "Settings will apply when the desk comes online");
    const canUpdate = fw && d.fw && fw.version !== d.fw;
    const otaLine = d.ota ? `Last update: ${d.ota}${d.otaAt ? " (" + ago(d.otaAt) + ")" : ""}` : null;
    fill(status,
      h("div", { class: "title" }, h("span", { class: "dot" + (d.online ? " on" : "") }), d.online ? "Online" : "Offline · last seen " + ago(d.lastSeen)),
      h("div", { class: "kv" },
        "firmware", h("b", {}, (d.fw || "?") + (fw ? (fw.version === d.fw ? " (latest)" : ` → ${fw.version} available`) : "")),
        d.ip ? ["ip", h("b", {}, d.ip)] : null,
        d.rssi != null ? ["wi-fi", h("b", {}, d.rssi + " dBm")] : null,
        "chip", h("b", {}, d.chip),
        rep && rep.packs ? ["packs", h("b", {}, rep.packs.join(", "))] : null),
      sync ? h("p", { class: "hint", style: "margin:10px 0 0" }, sync) : null,
      otaLine ? h("p", { class: "hint", style: "margin:6px 0 0" }, otaLine) : null,
      h("div", { class: "actions", style: "margin-top:12px" },
        canUpdate ? h("button", { class: "btn small primary", onclick: () => command("ota", `Update to ${fw.version}? The desk restarts when it's done (about a minute).`) }, "Update firmware") : null,
        h("button", { class: "btn small", onclick: () => command("reboot", "Restart the desk?") }, "Restart desk"),
        h("button", { class: "btn small", onclick: rename }, "Rename"),
        h("button", { class: "btn small ghost danger", onclick: forget }, "Forget")));
  }
  async function command(cmd, question) {
    if (!confirm(question)) return;
    try { await api("POST", `/api/devices/${enc}/${cmd}`); toast(cmd === "ota" ? "Update sent. Keep the desk powered." : "Restarting…"); await refresh(); }
    catch (e) { fail(e.code === "offline" ? new Error("The desk is offline.") : e); }
  }
  async function rename() {
    const n = prompt("Desk name", data.device.name || "Desk");
    if (n == null) return;
    try { await api("PATCH", `/api/devices/${enc}`, { name: n.trim() || "Desk" }); await refresh(); document.querySelector("header h1").textContent = data.device.name; }
    catch (e) { fail(e); }
  }
  async function forget() {
    if (!confirm(`Forget "${data.device.name || chip}"? It will show a new pair code and needs to be paired again.`)) return;
    try { await api("DELETE", `/api/devices/${enc}`); toast("Forgotten"); go("#/devices"); } catch (e) { fail(e); }
  }
  async function refresh() { data = await api("GET", `/api/devices/${enc}/settings`); paintStatus(); }
  paintStatus();

  // ---- settings form
  const seg = (key, options) => {
    const el = h("div", { class: "seg seg-" + options.length });
    const paint = () => fill(el, options.map(([val, label]) =>
      h("button", { type: "button", class: v[key] === val ? "on" : "", onclick: () => { v[key] = val; paint(); } }, label)));
    paint();
    return el;
  };
  const slider = (key) => {
    const out = h("span", { class: "val" }, v[key] + "%");
    const input = h("input", { type: "range", min: 0, max: 100, step: 1, value: v[key] });
    input.addEventListener("input", () => { v[key] = Number(input.value); out.textContent = input.value + "%"; });
    return h("div", { class: "slider" }, input, out);
  };
  const hours = (key) => {
    const sel = h("select", {}, Array.from({ length: 24 }, (_, i) => h("option", { value: i, selected: v[key] === i }, hourLabel(i))));
    sel.addEventListener("change", () => { v[key] = Number(sel.value); });
    return sel;
  };

  const installed = (data.reported && data.reported.packs) || ["pixel"];
  const packList = [{ id: "pixel", name: "Pixel", license: "Built in", preview: "/packs/pixel.png" }, ...data.packs];
  const packsEl = h("div", { class: "packs" });
  const paintPacks = () => fill(packsEl, packList.map((p) => h("button", {
    type: "button", class: "pack" + (v.pack === p.id ? " on" : ""), onclick: () => { v.pack = p.id; paintPacks(); },
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
          results.style.display = "none"; q.value = ""; paintPlace();
        } }, h("div", { class: "grow" }, h("div", { class: "title" }, label),
          h("div", { class: "sub" }, `${c.latitude.toFixed(2)}, ${c.longitude.toFixed(2)}`)));
      }) : h("div", { class: "empty" }, "No places found."));
    } catch { toast("City search is unavailable right now.", true); }
  }
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });

  const save = h("button", { class: "btn primary block", type: "submit" }, "Save to desk");
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = { layout: v.layout, soft: v.soft, casper: v.casper, pack: v.pack, bday: v.bday, bnight: v.bnight, nstart: v.nstart, nend: v.nend };
      if (locChanged) Object.assign(body, { lat: v.lat, lon: v.lon, place });
      save.disabled = true;
      try { data = await api("PUT", `/api/devices/${enc}/settings`, body); locChanged = false; paintStatus(); toast("Saved — your desk updates in a few seconds"); }
      catch (ex) { fail(ex); }
      finally { save.disabled = false; }
    },
  },
    h("h2", {}, "Look"),
    h("div", { class: "card" },
      h("label", { class: "f", style: "margin-top:0" }, "Layout"), seg("layout", [[1, "B · tall clock"], [0, "A · clean"]]),
      h("label", { class: "f" }, "Colours"), seg("soft", [[0, "Vivid"], [1, "Soft"]]),
      h("label", { class: "f" }, "Casper"), seg("casper", [[1, "On"], [0, "Off"]])),
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

  fill(main, h("h2", {}, "Status"), status, form);
  state.poll = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
}

// ------------------------------------------------------------------ Claude Code
async function viewClaude() {
  shell("Claude Code", h("div", { class: "empty" }, "Loading…"));
  const [{ token, hub }] = await Promise.all([api("GET", "/api/token"), loadMe()]);
  shell("Claude Code", []); // repaint header pill with fresh status
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
    h("h2", {}, "Status"),
    h("div", { class: "card status-card" }, h("span", { class: "big" }, icons[v.s] || "•"),
      h("div", { class: "grow" }, h("div", { class: "title" }, words[v.s] || v.s),
        h("div", { class: "sub" }, [v.p, v.d].filter(Boolean).join(" — ") || "Across all your Claude Code sessions"))),
    h("h2", {}, "Install the hook"),
    h("div", { class: "card" },
      h("p", { class: "hint", style: "margin-top:0" }, "Run this once on each computer where you use Claude Code. It adds a tiny hook that reports status to your desk (never your code or tool output)."),
      cmd("macOS / Linux (Terminal)", unix),
      cmd("Windows (PowerShell)", win)),
    h("h2", {}, "Hook token"),
    h("div", { class: "card" },
      h("div", { class: "codebox", style: "margin-top:0" }, tokenEl,
        h("button", { class: "btn small", onclick: (e) => { shown = !shown; tokenEl.textContent = shown ? token : "•".repeat(24); e.target.textContent = shown ? "Hide" : "Show"; } }, "Show"),
        h("button", { class: "btn small", onclick: () => copy(token) }, "Copy")),
      h("button", {
        class: "btn block danger", onclick: async () => {
          if (!confirm("Regenerate the token? Computers using the old one stop updating until you re-run the install command.")) return;
          try { await api("POST", "/api/token/regenerate"); toast("New token created"); viewClaude(); } catch (e) { fail(e); }
        },
      }, "Regenerate token")));
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
      class: "card", onsubmit: async (e) => {
        e.preventDefault();
        try { state.me = { ...state.me, ...(await api("PATCH", "/api/me", { displayName: name.value.trim(), tz: tz.value })) }; toast("Saved"); }
        catch (ex) { fail(ex); }
      },
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
  const hash = location.hash || "#/home";
  state.route = hash.slice(1);
  try {
    if (!state.config) state.config = await api("GET", "/api/config").catch(() => ({}));
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
      case "#/claude": return await viewClaude();
      case "#/settings": return await viewSettings();
      default: return await viewHome();
    }
  } catch (e) { if (e.status !== 401) fail(e); }
}

window.addEventListener("hashchange", render);
render();
