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
{ "id": 1234, "from": "chris", "name": "Chris", "rel": "friend|partner",
  "kind": "text|reaction", "text": "see you at 8?", "reaction": "heart", "t": 1762412345 }
```
* `id` strictly increases per hub. Device remembers the last shown id (persisted) and shows a message only if `id > lastShown`.
* `text` ≤ 100 chars (device wraps to ≤ 3 lines; hub enforces the length). Always a string: `""` for reactions.
* `reaction` is `""` for text messages. `name` ≤ 20 chars.
* `reaction` ∈ friend set `wave, thumbs, laugh, coffee, fire` and partner-only set `heart, hug, kiss, goodnight, missyou`.
  Hub rejects partner-only reactions for non-partner relationships.

### 3.3 `desk/<chip>/cfg` — retained, hub → device
Paired:
```json
{ "paired": true, "owner": "chris", "name": "Desk", "hub": "https://<public hub url>" }
```
Unpaired (re-published whenever the code rotates):
```json
{ "paired": false, "pairCode": "482913", "hub": "https://<public hub url>" }
```
`name` ≤ 20 chars. The hub re-publishes `cfg`, `claude` and `msg` whenever the device connects, so state survives a
hub restart.

### 3.4 `desk/<chip>/up/status` — device → hub (on connect, then every 10 min)
```json
{ "fw": "1.3.0", "ip": "192.168.1.107", "rssi": -40, "heap": 23000, "up": 3600 }
```
Hub stores it (last seen, fw, ip) for the web app.

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

* `POST /api/friends {username, rel: "friend"|"partner"}` → pending request.
* `POST /api/friends/<username>/accept`, `/decline`, `DELETE /api/friends/<username>`.
* Changing `rel` = new request that the other side must accept.
* A user may have any number of friends and partners (it's their business).

## 7. Client installers (served by the hub, hub URL baked in)

* `GET /install.sh` (macOS/Linux): `curl -fsSL https://<hub>/install.sh | bash -s -- <token>`
* `GET /install.ps1` (Windows PowerShell): `$env:CLAUDE_DESK_TOKEN='<token>'; irm https://<hub>/install.ps1 | iex`
* Both write `~/.claude-desk/config.json` `{ "hub": "https://<hub>", "token": "<token>" }`, install the hook script into
  `~/.claude-desk/`, merge hooks into `~/.claude/settings.json` (backup first, idempotent, remove older claude-desk
  entries), and send a test event.
