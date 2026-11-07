# claude-desk hub

One Node/TypeScript process that does everything server-side for claude-desk (see `../docs/PROTOCOL.md`):

* **Web app + REST API** on `$PORT`: accounts, friends/partners, messages, device pairing, hook tokens.
* **Hook endpoint** `POST /api/hook`: runs the per-user Claude Code state machine and publishes the status to every desk the user owns.
* **MQTT broker over TLS** on `$MQTT_PORT` (aedes): devices connect here; per-chip ACL; retained `claude`, `msg`, `cfg` topics.
* **Installers**: `/install.sh`, `/install.ps1` (hub URL baked in), `/client/hook.py`, `/client/hook.ps1`, read from `../client`.
* **Remote desk settings** (retained `desk/<chip>/set`), **emoji packs** (`/packs/index.json`, `/packs/<id>.bin|png` from `hub/packs/`)
  and **firmware updates** (`/firmware/latest.json`, `/firmware/claude-desk.bin` from `../firmware/dist/`, `cmd` topic).
* **First-install guide** `/#/install` (public, phone-first): downloads `/firmware/claude-desk.bin.gz` (or the loader +
  full image), links to the desk's `http://<ip>/update`, and one tap on `http://<ip>/set?hub=<this hub>` connects it.
* **Apps** `/#/apps`: Claude Code install, timers, repeating reminders, rain alerts, calendar reminders (private iCal
  links), GitHub notifications, stock/crypto alerts, now playing (Spotify, or Last.fm for YouTube Music etc.), email
  (IMAP), Slack mentions and a personal webhook (`POST /api/notify/<token>`), delivered as `card` / `next`
  (PROTOCOL.md §3.5, §3.6, §11).
* **Drawings**: draw on your own desk, or with a friend on both desks at once, live (binary `draw` topic and
  Server-Sent Events to the browsers; PROTOCOL.md §3.8, §12).
* **Wi-Fi management** for each desk: saved networks, scan, add/remove relayed to the desk (passwords not stored).

Storage is one SQLite file in `$DATA_DIR`, next to the session secret and the broker's TLS cert. Runs as a single instance.

## Run locally

```bash
cd hub
npm install
npm test                      # build + end-to-end test (HTTP, MQTT/TLS, state machine, ACL)
HUB_INVITE_CODE=dev npm run dev   # http://localhost:3000, MQTT/TLS on :8883, data in ./data
```

Try it without a device:

```bash
curl -s localhost:3000/api/device/hello -H 'content-type: application/json' \
  -d '{"chip":"esp-1a2b3c","fw":"dev","secret":""}'
# -> secret + pairCode; enter the code on the Devices page, then e.g.:
npx mqtt sub -h localhost -p 8883 -l mqtts --insecure -i esp-1a2b3c -u esp-1a2b3c -P <secret> -t 'desk/esp-1a2b3c/#' -v
```

## Deploy on Railway

The hub serves the client installers from `../client`, so it is built from the **repository root** with `hub/Dockerfile`
(a service whose Root Directory is `hub` can't see `../client` or `../firmware/dist`).
The image contains `client/`, `hub/packs/` and `firmware/dist/` — commit new firmware builds/packs and Railway redeploys.

1. **New service → GitHub repo** (this repo). Leave *Root Directory* empty.
2. *Settings → Build / Deploy* (new Railway services can't use a `railway.json` config file any more, so set these by
   hand): Dockerfile path `hub/Dockerfile`, watch paths `hub/**`, `client/**`, `firmware/dist/**`, health check
   `/healthz` (timeout 60 s), restart policy *on failure* (10 retries), one replica.
3. **Add a volume** mounted at `/data`.
4. **Variables**:
   * `DATA_DIR=/data` (the Dockerfile sets it too)
   * `HUB_INVITE_CODE=<something friends will type once>`
   * `PORT=8080`: without it Railway picks the Dockerfile's `EXPOSE 8883` for HTTP and the web server collides with the
     MQTT listener (`EADDRINUSE`)
   * optional `PUBLIC_URL=https://<your domain>` if you use a custom domain (default: `https://$RAILWAY_PUBLIC_DOMAIN`)
5. *Settings → Networking*:
   * **Generate Domain** (HTTP) with target port **8080**. You can rename it (e.g. `<name>.up.railway.app`).
   * **TCP Proxy** → target port **8883**. Railway then sets `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT`, which the hub hands to devices
     (override with `MQTT_PUBLIC_HOST` / `MQTT_PUBLIC_PORT`). Redeploy once after enabling it so the variables are picked up.
6. Deploy. The log shows the URL, the MQTT host:port and the cert fingerprints. Open the domain, create your account with the invite code.

Keep it at **one replica** (SQLite + in-process broker). The volume keeps the DB, the session secret and the MQTT cert; if you lose it,
devices pinned to the old key must re-run hello (they do on every boot) and everyone re-pairs.

Alternative without Docker: Root Directory `hub` works with Railway's Node builder (`npm run build` / `npm start`, Node ≥ 22), but then
`/install.sh` & co. return 404 unless you copy `client/` into `hub/client/` (the hub also looks there) or set `CLIENT_DIR`.

## Environment

| variable | default | |
|---|---|---|
| `PORT` | `3000` | HTTP (set by Railway) |
| `MQTT_PORT` | `8883` | MQTT/TLS listen port (TCP Proxy target) |
| `DATA_DIR` | `./data` | SQLite DB, `mqtt-cert.pem`, `mqtt-key.pem` |
| `HUB_INVITE_CODE` | – | required to register; unset = open registration (a warning is logged) |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN`, else the request's host | baked into installers and `cfg.hub` |
| `MQTT_PUBLIC_HOST` / `MQTT_PUBLIC_PORT` | `RAILWAY_TCP_PROXY_DOMAIN` / `_PORT`, else request host / `MQTT_PORT` | sent to devices in hello |
| `SESSION_SECRET` | generated, stored in the DB | cookie signing |
| `MQTT_TLS_CERT` / `MQTT_TLS_KEY` | self-signed RSA-2048 in `DATA_DIR` | PEM, `\n` escapes allowed. Use RSA-2048 (ESP8266). |
| `CLIENT_DIR` | `../client` | installer + hook sources |
| `FIRMWARE_DIR` | `../firmware/dist` | `claude-desk.bin` + `version.txt` (md5/size computed at start, re-read when the file changes) |
| `PACKS_DIR` | `./packs` | `<id>.bin`, `<id>.png`, `index.json` (names/licenses; size/md5 recomputed from the files) |
| `HOST` | `0.0.0.0` | bind address |
| `HUB_QUIET` | – | `1` silences the startup log |
| `SPOTIFY_CLIENT_ID` | – | enables Spotify now playing. Create an app at developer.spotify.com (Web API), redirect URI `<hub>/api/apps/spotify/callback`. In development mode only users you add on the app's dashboard (up to 25) can connect. |
| `LASTFM_API_KEY` / `LASTFM_SHARED_SECRET` | – | enables Last.fm now playing (last.fm/api/account/create gives both). The key alone allows typing a username; with the secret users get a "Sign in with Last.fm" button. |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | – | enables Slack mentions. Create an app at api.slack.com/apps, add the **user** scope `search:read` and the redirect URL `<hub>/api/apps/slack/callback` |

## API (web app)

Session cookie (`cd_sid`, httpOnly, SameSite=Lax, signed). JSON in/out, errors as `{"error":"code"}`.

| | |
|---|---|
| `GET /api/config` | `{inviteRequired, hub}` |
| `POST /api/register` | `{username, password, displayName?, invite?, tz?}` |
| `POST /api/login` / `POST /api/logout` | `{username, password, tz?}` (tz updates the user's timezone until they set one by hand) |
| `GET /api/me` / `PATCH /api/me` | `{displayName?, tz?}`; `GET` also returns the current Claude view |
| `GET /api/token` / `POST /api/token/regenerate` | hook token |
| `GET /api/devices`, `POST /api/devices/pair {code, name}`, `PATCH /api/devices/:chip {name}`, `DELETE /api/devices/:chip` | |
| `GET /api/devices/:chip/settings`, `PUT /api/devices/:chip/settings` | desired + reported settings, packs, latest firmware; PUT publishes `set` |
| `POST /api/devices/:chip/ota`, `POST /api/devices/:chip/reboot` | `cmd` to the desk (409 if offline), 10/min per user |
| `GET /api/friends`, `POST /api/friends {username, rel}`, `POST /api/friends/:u/accept`, `POST /api/friends/:u/decline`, `DELETE /api/friends/:u` | decline also cancels your own outgoing request |
| `POST /api/messages {to, kind, text?, reaction?}`, `GET /api/messages?with=<u>` | |
| `POST /api/device/hello`, `POST /api/hook`, `POST /api/nowplaying` | device / hook client / now-playing helper (hook token), see PROTOCOL.md |

Limits: login 20/min per IP and 10/min per username, register 10/h per IP, hello 30/min per IP, pairing 10 tries per 10 min per user,
messages 10/min per sender, hook 600/min per user. Bodies ≤ 16 KB (hook 8 KB).

## Layout

```
src/main.ts      entry (env → startHub, graceful shutdown)
src/hub.ts       wires DB, TLS, broker, HTTP, timers
src/config.ts    env parsing
src/db.ts        SQLite schema
src/state.ts     Claude Code state machine (port of cdesk.py State/view)
src/service.ts   devices/pairing, status publishing, friends, messages
src/routes.ts    HTTP routes, sessions, rate limits, installers, static files
src/apps.ts      hub-side integrations (timers, reminders, calendar, GitHub, markets, music, rain, email, Slack)
src/doodles.ts   live drawings (sessions, stroke validation/chunking, SSE listeners)
src/net.ts       safeFetch for user-supplied URLs (public https only)
src/broker.ts    aedes on a Node TLS server, auth + ACL
src/tls.ts       cert load/generate, fingerprints, cipher list
src/files.ts     firmware image + pack index (md5/size), file cache
src/util.ts      scrypt, tokens, rate limiter, truncation, time formatting
public/          web app (vanilla JS/CSS, no build)
packs/           emoji packs (generated by firmware/tools/emoji.py --packs hub/packs)
test/            end-to-end test (node:test + mqtt.js)
```
