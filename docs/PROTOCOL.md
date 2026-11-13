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
(1.4.11 and 1.4.12 also drew a "!" on the clock's Claude face from an extra `w` count; 1.4.13 dropped it because the
NEEDS card stays up until the request is answered.)
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
payload clears it. A friend's unread message takes the same spot and wins while it's there.

`{ "text": "Blinding Lights · The Weeknd", "at": 0, "left": false, "k": "music" }` (firmware ≥ 1.4.6) is what's playing
now: the text is shown as-is after a note icon and never expires; the hub clears it when playback stops. Older firmware
ignores `k` and, with `at: 0`, shows nothing.

The hub sends the most urgent of: the next running timer, a calendar event within 15 min, what's playing (if the music
app's "show on the clock" is on), a calendar event within 12 h (if enabled).

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
Firmware ≥ 1.4.7 also leaves a network that is up but has no internet: with 2+ saved networks, after 3 min without a
sign of internet (MQTT connected or a weather fetch) it tries a TCP connect to 1.1.1.1:443 / 8.8.8.8:53; if that fails
it scans while still connected and, only if another saved network is in range, disconnects and avoids the bad one for
10 min (it still falls back to it when nothing else is visible).
1.4.4 and older used ESP8266WiFiMulti with a 3 s join limit, which failed on routers slower than a phone hotspot.

### 3.8 `desk/<chip>/draw` — binary, not retained, hub → device (firmware ≥ 1.4.6)
Live drawings (section 13). Every frame starts with `op` and a 16-bit drawing id (big-endian):

| op | rest | desk |
|---|---|---|
| 1 start | name length (1 byte) + UTF-8 name (≤ 40 bytes) | clears the screen to black and shows the drawing (not over NEEDS YOU, the pairing screen or a friend's message) |
| 2 strokes | stroke data, ≤ 700 bytes | draws it |
| 3 end | seconds to keep it, 16-bit (10–3600; 0 = until back to clock, firmware ≥ 1.4.10) | "from <name>" footer, back to the clock after that time |
| 4 clear | — | clears the canvas |
| 5 back to clock | — | firmware ≥ 1.4.8: leaves the drawing now, whatever its id (older firmware ignores it) |

Stroke data: `0xFF, colour (0–11), width (1–24)` starts a stroke, then `x, y` byte pairs (0–239) are its points, joined
by lines. `0xFE, colour` fills the whole canvas with that colour (firmware ≥ 1.4.12; points after it need a new
stroke header). Colours: white, black (eraser), red, orange, yellow, green, teal, blue, purple, pink, brown, grey.
Lines, boxes and circles from the web app are ordinary strokes (2, 5 and 17–61 points). The hub splits long strokes
so each frame starts with a stroke header (or a fill) and a continued stroke repeats its last point.

### 3.9 `desk/<chip>/media` — binary, not retained, hub → device (firmware ≥ 1.4.9)
A photo or GIF (section 14), streamed into the desk's storage as `/m.bin` (one at a time; the previous one is deleted
first). Every frame starts with `op` and a 16-bit transfer number (big-endian):

| op | rest | desk |
|---|---|---|
| 1 begin | size u32, CRC-32 u32, seconds u16 (10–3600; 0 = until back to clock, ≥ 1.4.10), name length u8 + UTF-8 name (≤ 40, `you` = your own) | needs size + 16 KB free in LittleFS, else answers `space` |
| 2 chunk | offset u32 + up to 700 bytes | appended in order, else `order` |
| 3 end | — | checks size and CRC (`crc`), answers, then plays it (not over NEEDS YOU, pairing or a message) |
| 4 stop | — | back to the clock |

Answer on `desk/<chip>/up/media`: `{"id":<transfer>,"ok":true}` or `{"id":…,"ok":false,"e":"space|order|crc|fs"}`.
The desk loops a GIF until the time is up (Back to clock, draw op 5, also stops it); a still from a friend gets a
"from <name> · hh:mm" footer and their name in the unread line like a drawing.

File format (little-endian): `DKM1`, frames u16, 2 reserved bytes, then per frame: delay ms u16, x u8, y u8, w u8,
h u8 (the changed rectangle; w = 0: nothing changed), data length u32, data. The data covers the rectangle row by row
with tokens: `00nnnnnn` skip n+1 pixels (unchanged), `01nnnnnn` + colour: n+1 pixels of that colour, `10nnnnnn` + n+1
colours; `11kkhhhh llllllll` is the same with kind k (0 skip, 1 run, 2 literal) and count `hhhhllllllll`+1 (≤ 4096).
Colours are RGB565. Frame 0 always covers the whole 240×240 screen.

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
| PostToolUse | remove pending entries matching `tid` or tool key; if that answered the last pending one, clear generic; with no pending at all, clear generic only if it is ≥ 3 s old (hooks run async and in parallel, so the previous tool's PostToolUse can arrive after the prompt's Notification); active = now |
| Notification (`ntype` ∈ permission_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input; or no ntype and msg contains "permission") | if no pending: generic = msg |
| Stop | clear pending + generic; done = now |
| SessionEnd | delete session |

View (priority): any pending/generic → **needs** (newest one; footer `"+N more waiting · HH:MM"`), else a `done` < 10 s old → **done**, else any session active < 15 min and not done → **working**, else **idle**.
Sessions idle > 6 h are dropped. Times in the footer use the user's IANA timezone (auto-detected from the browser at login via `Intl`, editable in settings; default UTC).
Hub publishes the view to `desk/<chip>/claude` for **every device owned by that user** whenever it changes, plus re-evaluates on a 1 s timer (for the done → idle/working transition).

## 5. Messages (web app)

* `POST /api/messages {to: "<username>", kind: "text"|"reaction", text?, reaction?}` — sender must be friends with `to`.
  Rate limit: 10/min per sender. Stored with id, delivered by publishing retained `desk/<chip>/msg` to each of the recipient's devices.
* `GET /api/messages?with=<username>` — conversation history (newest first, 50). If a friend's message, drawing or
  photo arrived since you last opened a chat, this also sends `{"cmd": "seen"}` on `desk/<chip>/cmd` to your desks
  (firmware ≥ 1.4.10), which clears the "from <name>" unread line on the clock (otherwise it expires after 3 h). A finished shared drawing appears as
  `kind: "doodle"` with `doodle` = its stroke data in base64 (section 13); a photo or GIF as `kind: "media"` with
  `media: {id, kind: "image"|"gif"|null}` (null once deleted; preview at `GET /api/media/<id>/preview`).

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
* Unless `CLAUDE_DESK_NO_AGENT=1`, they also start the computer agent (section 12): `agent.py` as the LaunchAgent
  `com.claude-desk.agent` (macOS) or the systemd user service `claude-desk-agent` (Linux), or `agent.ps1` from a
  `claude-desk-agent` shortcut in the Startup folder (Windows, via `conhost --headless`). On macOS they also compile
  `calendar.swift` into `~/.claude-desk/claude-desk-calendar` (Info.plist with the calendar usage text embedded,
  ad-hoc signed as `com.claude-desk.calendar`) and run it every 5 min as the LaunchAgent `com.claude-desk.calendar`; it
  writes `~/.claude-desk/calendar.json`. Older `nowplaying` agents are removed.

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
* **Google Calendar** — `GET /api/apps/google/connect` → Google OAuth (PKCE + client secret, `access_type=offline`,
  `prompt=consent`, scopes `openid email https://www.googleapis.com/auth/calendar.readonly`) → `GET
  /api/apps/google/callback` → `/#/apps?ok=google` or `?err=google_denied|google_scope|oauth_state` (`google_scope`:
  the user unticked the calendar box). Every 10 min the hub refreshes the access token itself, reads the calendar list
  (only calendars ticked in Google, up to 10) and their events for the next 36 h (`singleEvents=true`; all-day,
  cancelled and declined events skipped), and merges them with the other calendar sources for reminders and the
  next-up line. `DELETE /api/apps/google` disconnects and revokes the token. Shown as `calendar.google` in
  `GET /api/apps` `{configured, connected, email, ok, error, at, upcoming}`. Needs `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET`; `calendar.readonly` is a sensitive scope, so until Google verifies the app users see an
  "unverified app" screen and at most 100 can sign in.
* **Calendar links** — the user pastes private iCal links (Google "secret address in iCal format", Apple public calendar
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
* **Music** — what's playing becomes the next-up line (3.6, `k: "music"`) and, optionally, a short `Now playing` card
  per song. From the computer (no account; section 12); the hub drops a computer's song after 150 s without a report;
  `PATCH /api/apps/music/computer {clock?, cards?}`. When several
  sources play, a Spotify account beats the computer, which beats Last.fm, as long as the stronger one reported in the
  last 90 s. Spotify account: `GET /api/apps/spotify/connect` (signed in; redirects to Spotify's OAuth with PKCE, scopes
  `user-read-currently-playing user-read-playback-state`), Spotify returns to `GET /api/apps/spotify/callback`, which
  redirects to `/#/apps?ok=spotify` or `?err=<code>`; the hub polls `currently-playing` every 15 s while something plays,
  30 s otherwise, and refreshes the token itself. A Spotify app in development mode only lets accounts listed on its
  dashboard in; anyone else gets 403 from `/v1/me` and is sent back with `err=spotify_invite_only`.
  Last.fm (any app that scrobbles: Spotify, YouTube Music, Apple Music, Deezer, Tidal…): `GET /api/apps/lastfm/connect`
  (needs `LASTFM_SHARED_SECRET` too) → Last.fm's web auth with `cb = <hub>/api/apps/lastfm/callback/<state>` → the hub
  calls `auth.getSession` (signed with the secret) for the username; or `PUT /api/apps/lastfm {user}` (checked with
  `user.getinfo`). Polled every 30 s with `user.getrecenttracks`. `PATCH /api/apps/music/<spotify|lastfm> {clock?, cards?}`. Spotify wins when both play.
  Music is only polled while one of the user's desks is online. Needs `SPOTIFY_CLIENT_ID` / `LASTFM_API_KEY`.
* **Reminders** — `GET/POST /api/reminders`, `DELETE /api/reminders/<id>`; at most 20. `{kind: "every", label ≤ 24,
  every: 15|30|45|60|90|120|180|240 (min), start, end (minutes after midnight), days}` repeats between start and end;
  `{kind: "at", label, at, days}` fires once a day. `days` is a bitmask, Monday = bit 0 (31 = weekdays, 127 = every
  day). Times are in the user's time zone. Each one is a yellow `Reminder` card (60 s).
* **Rain alerts** — `PUT /api/apps/rain {on}` (400 `no_location` until a desk has a location). Every 15 min the hub
  reads Open-Meteo's 15-minute precipitation for the desk's location; when it isn't raining and ≥ 0.2 mm is due in the
  next 30 min, a blue `Weather` card ("Rain soon · in about 20 min · 1.8 mm in the next hour"), then nothing for 3 h
  (or until an hour after it stops raining).
* **Email** — IMAP with an app password: `PUT /api/apps/email {host, user, pass, subjects?}` (port 993 TLS; the host
  must resolve to a public address; checked by logging in), `PATCH /api/apps/email {subjects}`. Every 3 min the hub
  reads INBOX `STATUS` and the envelopes of new messages: an orange `Email` card per new mail (sender + subject, or
  "New email"), at most 3 (+ "N more"). Errors: `email_host`, `email_login`, `email_unreachable`. Outlook.com/Microsoft
  365 no longer allow app passwords for IMAP, so they don't work.
* **Slack** — `GET /api/apps/slack/connect` → Slack OAuth v2 with the user scope `search:read` → `GET
  /api/apps/slack/callback`. Every 60 s the hub searches `<@you>` and sends a purple `Slack` card ("sam in #general")
  per new mention by someone else, at most 3 (+ "N more"). Needs `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
* `DELETE /api/apps/<spotify|lastfm|rain|email|slack>` disconnects one. Tokens and passwords are stored on the hub and
  never returned by the API; an OAuth `state` is single-use and expires after 10 min.
* `GET /api/apps` returns all of it for the page (webhook URL, timers, calendar status and the next 3 events, GitHub
  login + status, last prices, music/email/Slack/rain status); `POST /api/apps/test` sends a test card.
* Outgoing fetches of user-supplied URLs (calendars) only go to public addresses: https only, private/loopback/
  link-local/CGNAT and `*.internal`/`*.local` hosts are refused, redirects are re-checked, 3 MB / 15 s limits.
  `GITHUB_API`, `QUOTES_API`, `WEATHER_API`, `SPOTIFY_ACCOUNTS`, `SPOTIFY_API`, `LASTFM_API`, `SLACK_API` and
  `ALLOW_PRIVATE_FETCH=1` exist for tests only.

## 12. The computer agent

One agent per computer (installed with the hook, section 7) reports to `POST /api/computer` with the hook token
(`/api/nowplaying` is an alias), on every change, every 60 s while something plays and every 120 s otherwise:
```json
{ "os": "mac", "playing": true, "title": "Blinding Lights", "artist": "The Weeknd", "app": "Spotify", "error": null,
  "badges": { "Slack": 3, "Mail": 12, "WhatsApp": -1 }, "away": false, "idle": 4,
  "calendar": "ok", "events": [{ "t": "Design review", "s": 1762412345, "e": 1762414145, "l": "Room 2" }] }
```
→ `{ok, off}`. Every field is optional.
* **Music** (`playing`, `title`, `artist`, `app`, `error`: `not_allowed`, `no_playerctl`, `unsupported`, `script`):
  macOS reads `pmset -g assertions` (coreaudiod's "Created for PID") to see which apps are playing audio, then asks
  Spotify / Music through AppleScript, or reads the tab titles of Chrome, Arc, Edge, Brave or Safari and keeps only known
  media sites (YouTube, YouTube Music, Spotify web, SoundCloud, Apple Music, Twitch, Netflix…; nothing else leaves the
  computer). Windows: every media session Windows knows about. Linux: `playerctl`.
* **Unread counts** (`badges`, macOS only; `-1` = a badge without a number). Two sources, merged: `lsappinfo` (no
  permission, but misses apps such as WhatsApp that set their badge through the notification system) and, optionally,
  the Dock's accessibility tree (`AXStatusLabel` of every Dock item), read by `claude-desk-dock` (`dock.swift`,
  compiled at install, its own LaunchAgent `com.claude-desk.dock` so the Accessibility grant belongs to it; writes
  `~/.claude-desk/badges.json` every 10 s; asks for Accessibility once). `dock`: `ok` / `not_allowed` tells the page
  whether that second source works. A third source needs nothing new: the tab titles of web apps in Chrome, Arc,
  Edge, Brave and Safari ("(3) WhatsApp", "Inbox (5) … Gmail"; WhatsApp Web, Gmail, Slack, Discord, Telegram, Teams,
  Messenger, Outlook), read every 30 s. On Windows 10/11 `agent.ps1` reads the notification store
  (`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`) through the system's `winsqlite3.dll`: an app's
  badge value if it has one, else its number of toasts still in the notification centre, for WhatsApp, Slack, Discord,
  Teams, Telegram, Messenger, Outlook and Signal (written without a Windows machine: untested).
* **Self-update**: every 6 h (first check 10 min after start) the agent downloads `/client/hook.*` and
  `/client/agent.*` from its hub (https only). A file that differs, is at least 500 bytes, contains its endpoint path
  and parses (`compile()` / PowerShell's parser) replaces the installed one; a new agent then exits and is restarted
  (launchd / systemd / a fresh hidden process on Windows). The Swift helpers still need the installer. a card
  (`<App>`, "3 unread" / "Something new", 20 s) when an app's count goes up, at most one per app per minute, never on
  the first report. Muted by default: App Store, System Settings. The hub remembers up to 30 app names for the page.
* **Away** (`away`, `idle` seconds): idle ≥ 10 min (macOS `HIDIdleTime`, Windows `GetLastInputInfo`, Linux
  `xprintidle`). `GET /api/friends` adds `presence: {away, since}` to accepted friends who share it: away when the flag
  says so or when their computer hasn't reported for 5 min, `null` when they turned it off or never set up an agent.
* **Calendar** (`calendar`: `ok`, `pending`, `not_allowed`, `stale`; `events`: up to 60, next 36 h, sent on change and
  every 10 min): macOS from `calendar.json` (EventKit: every calendar in the Calendar app, recurring events expanded,
  all-day and cancelled ones skipped); Windows from classic Outlook while it runs (COM, `IncludeRecurrences`). The hub
  keeps them in memory (dropped after 6 h without a report), merges them with calendar links (same title + start =
  one event) and uses them for reminders and the next-up line exactly like section 11's Calendar.
* `PATCH /api/apps/computer {music?, calendar?, presence?, mute?: {"<App>": true|false}}` → the computer's view:
  `{seen, os, music, calendar, presence, away, cal, apps: [{app, count, muted}]}` (also `computer` in `GET /api/apps`).

## 13. Drawings

Draw in the web app; every stroke shows up on the desk as you draw (3.8).

* `POST /api/doodles {to?}` → `{id, joined}`. With `to` (a friend's username) it's a shared drawing on both people's
  desks; if one is already open between you, you join it (`joined: true`). Without `to` it's your own canvas, only on
  your desk. 403 `not_friends`, 30 new drawings per hour.
* `GET /api/doodles/active` → open drawings you're part of (`{id, with, withName, startedByMe}`); the web app shows a
  "join" banner for them. `GET /api/doodles/<id>` → `{id, with, open, data (base64), started, ended}`.
* `POST /api/doodles/<id>/strokes {s, k?}` (base64 stroke data, ≤ 8 KB per call; whole drawing ≤ 48 KB, 413
  `too_big`; 400 `strokes` when malformed; `k` = the sender's stroke number, so a stroke sent in several calls is one
  step for undo), `POST .../undo` → `{undone}`: removes your most recent stroke (all calls with its `k`), then clears
  both desks (op 4) and redraws what's left, and sends `reset {by, s}` (the whole drawing) to the browsers;
  `POST .../clear`, `POST .../end {secs}` (how long the desks keep showing it; a shared
  drawing is then saved in your chat with each other), `DELETE /api/doodles/<id>` (own canvas only).
* `GET /api/doodles/<id>/events` — Server-Sent Events: `init {data}`, `strokes {by, s}`, `clear {by}`, `reset {by, s}`, `end`; a ping
  comment every 20 s. Both browsers draw from this, so you see each other's lines live.
* `GET /api/showing` → what the hub last put on your desk and hasn't ended: `{kind: "drawing"|"image"|"gif", id,
  from ("you" or a friend's name), until (unix seconds, null = until back to clock), live}` or `null`. Seconds in
  `end`, `show` and section 14's `show` accept 0 for "until back to clock".
* `POST /api/doodles/hide` → back to the clock on your own desks: ends your open own-canvas drawing (saved), then
  sends the last drawing shown there an end with 10 s (older firmware) followed by op 5 (1.4.8+: immediately).
* `GET /api/doodles/mine` → your last 20 own-canvas drawings; `POST /api/doodles/<id>/show {secs}` puts one back on
  your desks.
* A desk goes back to the clock 2 minutes after the last stroke. When strokes arrive more than 100 s after the
  previous ones, the hub first resends the start frame and everything drawn so far, so the drawing comes back on the
  desks and continues.
* A drawing with no stroke for 30 min is ended by the hub (shown for 60 s) and saved. Strokes are limited to 1200 calls/min.

## 14. Photos & GIFs

* `POST /api/media[?fit=contain]` with the file as the body (`image/*` or `application/octet-stream`, ≤ 12 MB) →
  `{id, kind: "image"|"gif", frames, bytes, created}`. The hub decodes it (sharp: JPEG, PNG, WebP, GIF, AVIF…; EXIF
  rotation applied), crops it to fill 240×240 (`contain`: fits it with black bars), converts to RGB565 and encodes it
  in the section 3.9 format, keeping only the changed rectangle of each GIF frame. Up to 240 frames; delays under
  20 ms count as 100 ms. If it's over 450 KB the hub drops every other frame (adding their delays) until it fits, else
  413 `media_too_big`. 400 `media_unreadable`; at most 30 per user (`media_full`), 30 uploads an hour.
* `GET /api/media` → `{items, deliveries: [{chip, media, state: "sending"|"ok"|"error"|null, error, at}]}` (the last
  transfer to each of your desks, from section 3.9's answers). `GET /api/media/<id>/preview` → a 160 px WebP (yours, or
  one in a chat you're part of). `DELETE /api/media/<id>`.
* `POST /api/media/<id>/show {secs}` → `{devices}`: streams it to your online desks (60 shows an hour).
  `POST /api/media/<id>/send {to}` → a friend's desks for 60 s plus a `media` chat message (20 an hour, friends only).
  A new transfer to the same desk cancels the one in flight. `POST /api/doodles/hide` (Back to clock) also stops it.

## 15. Notification preferences

Per user: `GET` / `PUT /api/notify-prefs` → `{msg, app: "full"|"banner", done: "full"|"banner"|"off", secs: 5|15|30|60|180
(how long friend messages stay; default 180), speed: 1|2|3, dnd, quiet, qfrom, qto (minutes after midnight, user's time
zone), off: [sources], sources, quietNow}`. The hub applies them; the desk only obeys per-message fields (firmware ≥
1.4.14, older firmware ignores them and shows everything full screen):

* `card` (3.5): `st: 1` = banner, `sp` = speed. Cards whose `src` is in `off`, and all cards while quiet (do not
  disturb, or inside quiet hours), are not sent.
* `msg` (3.2): `secs`, `st: 1` banner, `st: 2` = quiet: no pop-up, only the "from <name>" unread line; `sp`.
* `claude` (3.1): on `done`, `b: 1` = banner, `b: 2` = don't show (quiet, or "Claude finished: Off"). `needs` is never
  changed: permission prompts always show full screen.

Banner: the clock stays; on layout B the date line shows the source in its colour and the line under it scrolls the
text right to left (33 ms frames; 2, 3 or 6 px per frame); on layout A one line across the date row. A banner only
starts on the clock, otherwise the item shows the normal way.

Clock options ride on the normal settings (section 8): `h12` (12-hour time), `tf` (°F), `face` (0 hides the Claude
face). Stored in a spare byte of the desk's `Ext` block.
