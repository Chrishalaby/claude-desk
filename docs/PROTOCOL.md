# claude-desk protocol (v1)

Three parts talk to each other:

```
 Claude Code ──hook──▶  client/hook.(py|ps1) ──HTTPS──▶  HUB (Railway)  ──MQTT/TLS──▶  DEVICE (GeekMagic)
 phone/browser ──────────────── HTTPS (web app) ───────▶   HUB
```

* **Hub** — one Node/TypeScript service. HTTP (web app + REST) on `$PORT`, MQTT broker (TLS) on `$MQTT_PORT`.
  Railway exposes HTTP on its public domain and MQTT via a *TCP Proxy* (`RAILWAY_TCP_PROXY_DOMAIN:RAILWAY_TCP_PROXY_PORT`).
* **Device** — ESP8266 firmware. Talks to the hub over HTTPS once (hello/pairing), then keeps one MQTT/TLS connection.
* **Client** — tiny hook script per OS. Trims each Claude Code hook event and POSTs it to the hub. No local daemon.

All JSON is UTF-8. Times are unix seconds. Strings shown on the device are truncated by the hub to the limits below.

---

## 1. Accounts & auth (hub)

* Users: `username` (3–20 chars, `[a-z0-9_]`, unique, lowercase), `displayName` (≤ 20 chars), password (scrypt).
* Registration requires `HUB_INVITE_CODE` (env) if set, so strangers can't sign up.
* Web sessions: httpOnly, SameSite=Lax, signed cookie (`SESSION_SECRET` env, generated & persisted if absent).
* **Hook token**: per user, random 32 bytes hex, shown in the web app ("Claude Code" page), regenerable.
  Sent as `Authorization: Bearer <token>`.

## 2. Devices & pairing

Device identity = ESP8266 chip id as 6 lowercase hex chars, prefixed: `chip = "esp-" + hex(ESP.getChipId())`.

### 2.1 Hello — `POST https://<hub>/api/device/hello`

Request:
```json
{ "chip": "esp-1a2b3c", "fw": "1.3.0", "secret": "<stored secret or empty>" }
```
Response 200:
```json
{
  "secret": "<40 hex chars, only present when newly issued>",
  "paired": false,
  "pairCode": "482913",            // present when not paired (rotates every 10 min, new codes arrive via cfg, see 3.3)
  "owner": null,                   // username when paired
  "mqtt": { "host": "roundhouse.proxy.rlwy.net", "port": 12345, "tls": true,
            "fingerprint": "AB:CD:...(SHA-256 of the broker cert, 32 bytes hex with colons)",
            "pubkey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }
}
```
* `pubkey` = the broker cert's public key as SPKI PEM (RSA-2048, ~450 bytes). The ESP8266 pins it with BearSSL
  `setKnownKey()` (BearSSL can't pin a SHA-256 cert fingerprint; `fingerprint` is kept for other clients / display).
* The whole hello response is ~760 bytes (more than an MQTT payload); read it with a ~1 KB buffer.
* The device calls hello **once per boot**. After that it learns pairing state and new pair codes over MQTT only.
Rules:
* Unknown chip → create device, issue `secret`.
* Known chip + correct secret → no new secret.
* Known chip + missing/wrong secret → **403** (`{"error":"secret"}`). The owner must "Forget device" in the web app, after which hello creates it again.

### 2.2 Pairing

* Device shows `pairCode` on screen ("Pair code 482913 — enter it at <hub>").
* While unpaired, the hub rotates the code every 10 min (only while the device is connected) and re-publishes the
  retained `cfg` with the new `pairCode`. The previous code keeps working for 60 s after a rotation.
* User enters it in the web app → `POST /api/devices/pair {code, name}` → device linked to the user.
* Hub then publishes retained `desk/<chip>/cfg` with `"paired": true` (see 3.3). Device leaves the pairing screen.
* Forget (web app) deletes the device: hub publishes `cfg` `{"paired":false,"pairCode":null,...}`, clears the retained
  `claude`/`msg` (empty retained payload) and disconnects it. Its secret is then invalid (MQTT CONNACK 4); the device
  should run hello again (e.g. reboot), which re-creates it with a new secret and pair code.

## 3. MQTT

* Broker: TLS (self-signed cert generated on first start & persisted in `$DATA_DIR`, or `MQTT_TLS_CERT`/`MQTT_TLS_KEY` env). Plain TCP is not offered.
* TLS details: TLS 1.2 minimum (1.3 also offered), RSA-2048 cert (SHA-256 signature, CN = MQTT public host, ~25 y validity).
  TLS 1.2 suites in server-preference order: `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-RSA-CHACHA20-POLY1305`,
  `ECDHE-RSA-AES256-GCM-SHA384`, `ECDHE-RSA-AES128-SHA256`, `ECDHE-RSA-AES128-SHA` (ECDHE curves X25519 / P-256).
  No max-fragment-length extension (Node doesn't support it). Handshake records are ≤ ~1 KB each (Certificate ≈ 800 B).
  After the handshake the broker caps every record at **2048 bytes** of plaintext (`setMaxSendFragment`), so a device
  can use a 2 KB TLS receive buffer instead of 16 KB (the firmware uses BearSSL `setBufferSizes(2048, 512)`, ~14 KB
  less heap). A custom `MQTT_TLS_CERT` must keep each handshake record under 2 KB: one RSA-2048 cert, no chain.
* Device connects with: clientId = `chip`, username = `chip`, password = `secret`, keepalive 60 s, clean session.
* ACL: a device may subscribe only to `desk/<own chip>/#` and publish only to `desk/<own chip>/up/#`.
* Max payload the device accepts: **768 bytes**. Hub truncates fields so messages fit (cut strings end in `...`).
* Hub publishes with QoS 1 and retain. An **empty payload** on a retained topic means "cleared" — ignore it.
* Denied subscriptions get SUBACK `0x80`; a denied publish closes the connection.

### 3.1 `desk/<chip>/claude` — retained, hub → device
Claude Code status for the device owner (aggregated over all their sessions).
```json
{ "s": "idle|working|needs|done", "p": "project", "d": "detail", "f": "footer", "t": 1762412345 }
```
`p` ≤ 32, `d` ≤ 80, `f` ≤ 40 chars. Same meaning as the device's local `/state` endpoint.
All fields are always present; for `idle`/`working`, `p`, `d`, `f` are `""`. `t` = time of the request (needs),
of the Stop (done), of the activity that made it `working`, or when it went idle.

### 3.2 `desk/<chip>/msg` — retained (latest message only), hub → device
```json
{ "id": 1234, "from": "chris", "name": "Chris", "rel": "friend",
  "kind": "text|reaction", "text": "see you at 8?", "reaction": "heart", "t": 1762412345 }
```
* `id` strictly increases per hub. Device remembers the last shown id (persisted) and shows a message only if `id > lastShown`.
* `text` ≤ 100 chars (device wraps to ≤ 3 lines; hub enforces the length). Always a string: `""` for reactions.
* `reaction` is `""` for text messages. `name` ≤ 20 chars.
* `reaction` ∈ `wave, thumbs, laugh, coffee, fire, heart, hug, kiss, goodnight, missyou`, open to every friend.
* `rel` is always `"friend"` (there used to be a `"partner"` level; the hub converts old data on start). Firmware
  still styles `"partner"` differently, so the field stays for compatibility.

### 3.3 `desk/<chip>/cfg` — retained, hub → device
Paired:
```json
{ "paired": true, "owner": "chris", "name": "Desk", "host": "chris-desk", "hub": "https://<public hub url>" }
```
Unpaired (re-published whenever the code rotates):
```json
{ "paired": false, "pairCode": "482913", "hub": "https://<public hub url>" }
```
`name` ≤ 20 chars. The hub re-publishes `cfg`, `claude` and `msg` whenever the device connects, so state survives a
hub restart.

`host` is the device's local network name (mDNS `<host>.local` and DHCP hostname), assigned by the hub when the device
is paired and kept for as long as it stays paired: `<username>-desk` (runs of characters outside `[a-z0-9]` become
`-`), then `<username>-desk-2`, `-3`, … for the owner's further devices (lowest free suffix). The device stores it, so
it keeps the name across reboots and while the hub is unreachable. Unpaired devices (and devices whose hub sends no
`host`) use `claude-desk-<6 hex chars of the chip id>`; a `cfg` with `"paired": false` switches back to that name.
The device ignores a `host` that isn't 1–32 chars of `[a-z0-9-]` (no leading/trailing `-`).

### 3.4 `desk/<chip>/up/status` — device → hub (on connect, then every 10 min)
```json
{ "fw": "1.4.4", "ip": "192.168.1.107", "rssi": -40, "heap": 23000, "maxblk": 15000, "reset": "Software/System restart", "up": 3600 }
```
Hub stores it (last seen, fw, ip, heap, maxblk, reset) for the web app. `heap` = free heap, `maxblk` = largest free
block (what a new TLS session or JSON document actually needs), `reset` = `ESP.getResetReason()` of the current boot.
The web app flags `heap` < 8 KB and resets that mention Exception/Watchdog. The device's own `/info` has the same
fields. Firmware ≥ 1.4.4 restarts itself if `maxblk` stays under 3 KB for 2 minutes (at most once per 30 min uptime).

### 3.5 `desk/<chip>/card` — not retained, hub → device (firmware ≥ 1.4.5)
```json
{ "id": 7, "src": "CALENDAR", "title": "Standup", "text": "in 10 min · 10:00 · Room 4", "icon": "", "color": "blue", "secs": 60 }
```
A notification card from an app (section 11). `src` ≤ 20 chars (shown upper-case), `title` ≤ 40, `text` ≤ 120 (wraps to
3 lines, 1 line when there is an icon), `icon` = a reaction name (drawn like a reaction card) or `""`, `color` = one of
`teal orange green red blue purple pink yellow white` or `#rrggbb`, `secs` 3–300 (default 15). The desk shows it over
the clock or a DONE card, never over NEEDS YOU, a friend's message or the pairing screen; it is dropped if the desk is
offline. The hub limits cards to 30 per minute per user.

### 3.6 `desk/<chip>/next` — retained, hub → device (firmware ≥ 1.4.5)
```json
{ "text": "Standup", "at": 1762412345, "left": false }
```
One line under the clock's date (layout A: in the top-right corner). `left: false` → "Standup 10:00" (desk-local time of
`at`); `left: true` → a countdown, "Focus · 12 min" / "Focus · 1h 05m". The desk hides it once `at` has passed. Empty
payload clears it. A friend's unread message takes the same spot and wins while it's there. The hub sends the most
urgent of: the user's next running timer, else (if enabled) the next calendar event within 12 hours.

### 3.7 Wi-Fi, managed through the hub (firmware ≥ 1.4.5)
`desk/<chip>/cmd` (not retained) carries `{ "cmd": "wifi_scan" }`, `{ "cmd": "wifi_add", "ssid": "...", "pass": "..." }`
and `{ "cmd": "wifi_del", "ssid": "..." }`. The desk answers on `desk/<chip>/up/wifi` (also sent on every MQTT connect):
```json
{ "saved": ["Home", "Hotspot"], "current": "Hotspot", "rssi": -52, "visible": [{ "s": "Home", "r": -60, "o": 0 }] }
```
`visible` (strongest entry per name, `o` = open network) only after a `wifi_scan`. The hub stores this (never a
password; `wifi_add` is relayed and forgotten) for `GET /api/devices/<chip>/wifi`; `POST .../wifi/scan`,
`POST .../wifi {ssid, pass}` (pass empty or 8–63 chars) and `POST .../wifi/remove {ssid}` send the commands (owner only,
409 `offline`/`busy`). The desk keeps up to 4 networks; adding a 5th drops the oldest.

Switching networks (firmware ≥ 1.4.5): after 8 s without Wi-Fi the desk scans (async), joins the strongest saved
network that is actually visible and gives it 15 s, rescanning every 20 s; the screen and web pages keep working.
1.4.4 and older used ESP8266WiFiMulti with a 3 s join limit, which failed on routers slower than a phone hotspot.

## 4. Claude Code hooks

### 4.1 Client → hub: `POST https://<hub>/api/hook`
Header `Authorization: Bearer <hook token>`. The client sends a **trimmed** event (never tool output or file contents):
```json
{
  "e": "UserPromptSubmit|PermissionRequest|PostToolUse|Notification|Stop|SessionEnd",
  "sid": "<session_id>",
  "project": "<basename of cwd>",
  "tool": "Bash",                       // tool events only
  "detail": "npm test",                 // command / file basename / url / pattern, ≤ 60 chars, whitespace collapsed
  "tid": "<tool_use_id>",               // tool events only, when present
  "ntype": "permission_prompt",         // Notification only
  "msg": "Claude needs your permission…" // Notification only, ≤ 80 chars
}
```
Response `200 {"ok":true}` (fast; never blocks the hook); `401 {"error":"token"}` for a bad token. The client has a 2 s timeout and always exits 0 silently.

### 4.2 Hub state machine (per user, over all sessions)
Per session: `pending` (map tool key → {detail, since}), `generic` (notification needs), `done` timestamp, `active` timestamp.
Tool key = `tid` if present, else `tool + ":" + detail`.

| event | effect |
|---|---|
| UserPromptSubmit | clear pending + generic + done; active = now |
| PermissionRequest | pending[key] = "Allow <tool>: <detail>" ("Allow <tool>?" without detail); active = now |
| PostToolUse | remove pending entries matching `tid` or tool key; if none left clear generic; active = now |
| Notification (`ntype` ∈ permission_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input; or no ntype and msg contains "permission") | if no pending: generic = msg |
| Stop | clear pending + generic; done = now |
| SessionEnd | delete session |

View (priority): any pending/generic → **needs** (newest one; footer `"+N more waiting · HH:MM"`), else a `done` < 10 s old → **done**, else any session active < 15 min and not done → **working**, else **idle**.
Sessions idle > 6 h are dropped. Times in the footer use the user's IANA timezone (auto-detected from the browser at login via `Intl`, editable in settings; default UTC).
Hub publishes the view to `desk/<chip>/claude` for **every device owned by that user** whenever it changes, plus re-evaluates on a 1 s timer (for the done → idle/working transition).

## 5. Messages (web app)

* `POST /api/messages {to: "<username>", kind: "text"|"reaction", text?, reaction?}` — sender must be friends with `to`.
  Rate limit: 10/min per sender. Stored with id, delivered by publishing retained `desk/<chip>/msg` to each of the recipient's devices.
* `GET /api/messages?with=<username>` — conversation history (newest first, 50).

## 6. Friends

* `POST /api/friends {username}` → pending request (a `rel` field is ignored). If the other person already asked you,
  this accepts their request. Messages and reactions need an accepted request: someone can only put something on
  your desk after you said yes.
* `POST /api/friends/<username>/accept`, `/decline`, `DELETE /api/friends/<username>`.

## 7. Client installers (served by the hub, hub URL baked in)

* `GET /install.sh` (macOS/Linux): `curl -fsSL https://<hub>/install.sh | bash -s -- <token>`
* `GET /install.ps1` (Windows PowerShell): `$env:CLAUDE_DESK_TOKEN='<token>'; irm https://<hub>/install.ps1 | iex`
* Both write `~/.claude-desk/config.json` `{ "hub": "https://<hub>", "token": "<token>" }`, install the hook script into
  `~/.claude-desk/`, merge hooks into `~/.claude/settings.json` (backup first, idempotent, remove older claude-desk
  entries), and send a test event.

---

## 8. Remote settings (web app → desk, no flashing)

The web app's device page edits the desk's settings from anywhere (phone included).

* `desk/<chip>/set` — **retained**, hub → device:
  ```json
  { "rev": 1762412345, "layout": 1, "soft": 0, "casper": 1, "pack": "pixel",
    "bday": 25, "bnight": 10, "nstart": 22, "nend": 7, "lat": 33.97, "lon": 35.62 }
  ```
  `rev` = unix time of the change. The device applies it only if `rev` > the last rev it applied (persisted), so
  local edits made on the desk's own page aren't overwritten by an old retained copy. Omitted keys = unchanged.
  `pack` ∈ `pixel` (built in) or a pack id from `/packs/index.json`. When `pack` is a downloadable pack, `set` also
  carries `"packUrl": "https://<hub>/packs/<id>.bin"` and `"packMd5": "<md5 from the index>"`, so the device never
  needs the index. The hub guarantees `rev` strictly increases per device (`max(now, previous rev + 1)`) and publishes
  the merged desired state (every key ever set). `set` is re-published on connect / hub restart, cleared on forget.
* `desk/<chip>/up/settings` — device → hub, on connect and after any change (local page or `set`). Same keys, plus
  `"rev"` (last applied) and `"packs": ["pixel","fluent"]` (installed). The hub stores it and shows it in the web app.
  Messages a device publishes under `desk/<chip>/up/#` are consumed by the hub and **not** echoed back to the device's
  own `desk/<chip>/#` subscription.
* Web: `GET /api/devices/<chip>/settings`, `PUT /api/devices/<chip>/settings` (owner only) → publishes `set`.
  Location is picked with a city search in the browser (Open-Meteo geocoding API, called from the browser).
  PUT body: any subset of the keys plus optional `place` (display name, kept on the hub, never sent to the device);
  `lat`/`lon` must come together. 400 `{"error":"<key>"}` on an invalid value.

## 9. Packs (downloaded into the desk's 1 MB storage)

Emoji sets other than the built-in pixel art are **packs** the hub serves; a desk downloads the one it needs.

* `GET /packs/index.json` → `{ "packs": [ { "id": "fluent", "name": "Fluent", "license": "MIT (Microsoft)",
  "size": 34567, "md5": "<hex>" }, ... ] }` (built-in `pixel` is not listed).
* `GET /packs/<id>.bin` — binary, little-endian:
  ```
  "CDPK" | u8 version=1 | u8 count | u16 0
  count × { char name[16] (zero padded) | u8 w | u8 h | u16 0 | u32 offset | u16 pal[16] (RGB565) }   (56 bytes each)
  pixel data: 4-bit palette indices, row-major, 2 px per byte (high nibble first), per entry at `offset`
  ```
  Entry names: `wave thumbs laugh coffee fire heart hug kiss goodnight missyou` (80×80) and `heart_s wave_s` (44×44).
  Pack files are generated by `firmware/tools/emoji.py --packs hub/packs` and committed.
* The device downloads `https://<hub>/packs/<id>.bin` when `set.pack` names a pack it doesn't have (checks md5 from the
  index), stores it as `/packs/<id>.bin`, deletes other packs, then reports `up/settings`.

## 10. Remote firmware update

* `GET /firmware/latest.json` → `{ "version": "1.4.0", "url": "https://<hub>/firmware/claude-desk.bin", "md5": "<hex>",
  "size": 748640 }` — built from `firmware/dist/claude-desk.bin` and `firmware/dist/version.txt` in the repo.
* `GET /firmware/claude-desk.bin` sends `x-MD5: <hex md5>` (ESP8266httpUpdate checks it), `ETag`, `Cache-Control: no-cache`.
* `GET /firmware/claude-desk.bin.gz` and `/firmware/claude-desk-loader.bin` (first install from a browser, see the web
  app's `#/install` guide): same headers. All three are sent as `application/octet-stream` with
  `Content-Disposition: attachment` and no `Content-Encoding`, so phones save them as files unchanged.
  `latest.json` is `404 {"error":"no_firmware"}` until both `claude-desk.bin` and `version.txt` exist.
  `GET /packs/<id>.bin` also sends `x-MD5`; `/packs/<id>.png` is the web app's preview strip.
* Web app shows each desk's fw (from `up/status`) and an **Update** button when `latest.version` is newer. The hub
  refuses a downgrade (`409 {"error":"downgrade"}`) when the desk already runs a newer version than it serves.
  `POST /api/devices/<chip>/ota` / `POST /api/devices/<chip>/reboot` (owner only; `409 {"error":"offline"}` when
  the desk isn't connected, since `cmd` is not retained).
  An update counts as running from the `ota` request until the desk reports a different `fw` (hub then records
  `"ota": "ok: <old> → <new>"`), reports any `ota` result, or 5 minutes pass. While it runs, `ota`, `reboot` and
  `DELETE /api/devices/<chip>` answer `409 {"error":"busy"}`, and the device view has `"otaPending": true`.
* Button → `desk/<chip>/cmd` (not retained): `{ "cmd": "ota", "url": "...", "md5": "...", "version": "1.4.0" }`.
  Also `{ "cmd": "reboot" }`. The device disconnects MQTT, stores the download in RTC memory and restarts; right
  after Wi-Fi is up (before hello/MQTT, ~32 KB free) it downloads and flashes (ESP8266httpUpdate, md5 checked) and
  reboots. Pack downloads (`set` with a `packUrl`) take the same restart-then-download path. Measured on 1.4.1: doing
  the download in place after only disconnecting MQTT left too little heap for the HTTPS download (`connection
  failed`, or a crash). Outcome: `up/status` gains `"ota": "ok|failed: <reason>"`.

## 11. Apps (hub-side integrations → cards and the next-up line)

Everything below runs on the hub; the desk only receives `card` (3.5) and `next` (3.6), so it needs no extra memory
per integration. Web app: the **Apps** tab (`#/apps`). All endpoints are per signed-in user unless noted.

* **Webhook** — `POST /api/notify/<hook token>` or `POST /api/notify` with `Authorization: Bearer <hook token>` (the
  same token as the Claude Code hook). Body: JSON `{title?, text?, icon?, color?, secs?, src?}` (fields of 3.5; `src`
  defaults to `Webhook`), or `text/plain` (becomes `text`); the same fields also work as query parameters. Needs a title
  or a text. → `{ok, devices}`; 401 bad token, 429 over 120/min per IP or 30 cards/min per user.
* **Timers** — `GET/POST /api/timers {minutes 1–720, label ≤ 20}`, `DELETE /api/timers/<id>`; at most 10 running.
  The running one ending first is the next-up countdown; when it ends: a `Timer` card (60 s).
* **Calendar** — the user pastes private iCal links (Google "secret address in iCal format", Apple public calendar
  link, Outlook published ICS). `POST /api/apps/calendar/feeds {url}` (checked by fetching it once; `webcal://` is
  treated as `https://`), `DELETE /api/apps/calendar/feeds/<index>`, `PATCH /api/apps/calendar {remind: 0|5|10|15|30|60,
  showNext}`. At most 5 feeds. The hub refetches every 10 min and keeps events of the next 36 h in memory (time zones,
  daylight saving, RRULE repeats, EXDATE and overridden instances; all-day and cancelled events are skipped). A
  `Calendar` card goes out `remind` minutes before each event (once per event), and with `showNext` the next event
  within 12 h is the next-up line.
* **GitHub** — `PUT /api/apps/github {token}` (a classic token with only the `notifications` scope; checked with
  `GET /user`), `PATCH /api/apps/github {reasons: {review_requested, mention, ci_activity, assign, comment}}`,
  `DELETE /api/apps/github`. The hub polls `GET /notifications` (honours `X-Poll-Interval`, `If-Modified-Since`;
  never marks anything read) and sends a `GitHub` card per new notification with an enabled reason, at most 3 per poll
  (+ a "N more" card); CI cards are green, or red when the title says failed/cancelled. Only notifications updated after
  connecting count. The token is stored on the hub and never returned by the API.
* **Stocks & crypto** — `PUT /api/apps/stocks {items: [{symbol, above?, below?, move?}]}` (≤ 10; symbols like `AAPL`,
  `BTC-USD`, `EURUSD=X`, `^GSPC`). Every 5 min the hub reads `query1.finance.yahoo.com/v8/finance/chart/<symbol>`
  (unofficial, delayed). A `Markets` card when the price crosses `above` upwards or `below` downwards (the first reading
  only records the side), and once per day when the day's move is at least `move` percent.
* `GET /api/apps` returns all of it for the page (webhook URL, timers, calendar status and the next 3 events, GitHub
  login + status, last prices); `POST /api/apps/test` sends a test card.
* Outgoing fetches of user-supplied URLs (calendars) only go to public addresses: https only, private/loopback/
  link-local/CGNAT and `*.internal`/`*.local` hosts are refused, redirects are re-checked, 3 MB / 15 s limits.
  `GITHUB_API`, `QUOTES_API` and `ALLOW_PRIVATE_FETCH=1` exist for tests only.
