# claude-desk — notes for Claude Code

Project: custom firmware + hub + Claude Code hooks for a **GeekMagic SmallTV Ultra** (ESP8266, ST7789 240×240).
Read `README.md`, `docs/PROTOCOL.md` (the contract between firmware, hub and client) and `docs/INSTALL.md` first.

## Layout
- `firmware/` PlatformIO (`pio run -e main -e loader`). Prebuilt images in `firmware/dist/` (commit them: the hub image serves
  `dist/claude-desk.bin` + `version.txt` for OTA). Version comes from `-D FW_VERSION` in `platformio.ini` — bump it and
  `dist/version.txt` together.
  - Generators in `firmware/tools/`: `mkfont.py` (Inter → 4-bit AA fonts), `mkicons.py` (Meteocons weather icons),
    `casper.py` (dog sprites), `emoji.py` + `pixel_emoji.py` (built-in pixel reactions → `src/reactions.h`, and the
    downloadable packs → `hub/packs/`). Host previews: `firmware/tools/preview/*.cpp` + `gfx_host.cpp` (g++, writes PPM).
  - Flash layout `eagle.flash.4m1m.ld`: ~3 MB OTA space after the first install, LittleFS 1 MB (packs live in `/packs`).
  - EEPROM map: settings @0 (`Settings`, magic `0xDE5C0005`), Wi-Fi list @128 (`NetStore`), hub/ext @600 (`Ext`, magic
    `0x48554233`), local name @768 (`NameStore`, magic `0x484F5354`). Changing a struct = bump its magic (resets that
    block) or add a new block.
  - Local name (mDNS + DHCP): `claude-desk-<chip hex>` until paired, then the hub's `cfg.host` (`<username>-desk`,
    `-2`, … per owner), stored in `NameStore`. See PROTOCOL.md 3.3.
- `hub/` Node ≥22 TypeScript: fastify + aedes (MQTT/TLS) + better-sqlite3. `npm test` = full e2e (must stay green).
  Deploys on Railway from the **repo root** with `hub/Dockerfile`, volume at `/data`, `DATA_DIR=/data`,
  `HUB_INVITE_CODE`, `PORT=8080` (domain targets 8080), TCP Proxy → 8883. Build/deploy settings live on the Railway
  service (there is no railway.json: new services can't use config-as-code). The Dockerfile installs python3/make/g++
  because better-sqlite3 13 compiles from source.
  - `src/apps.ts` = hub-side integrations (timers, reminders, calendar via node-ical, GitHub notifications, Yahoo
    quotes, Spotify/Last.fm now playing, Open-Meteo rain, IMAP email via imapflow, Slack mentions); they only ever send
    `card` / `next` to desks (PROTOCOL.md §3.5, §3.6, §11). Spotify/Last.fm/Slack need env vars (hub/README.md).
  - `src/doodles.ts` = live drawings: binary `draw` topic to desks (§3.8), SSE to browsers (§13). `src/media.ts` =
    photos/GIFs: sharp → RGB565 delta/RLE format, streamed on `media` (§3.9, §14); the desk keeps one in
    LittleFS `/m.bin` and plays it with `firmware/src/media.cpp` (host check: `tools/preview/mediatest.cpp`). `src/net.ts` = `safeFetch` (public https
    only) for user-supplied URLs. New integrations go here, never on the desk.
- `client/` hook (`hook.py` macOS/Linux, `hook.ps1` Windows) + installers; the hub serves them with `__HUB_URL__` replaced
  (first occurrence only — keep the placeholder's first occurrence as the value). The installers also start the
  computer agent (`agent.py` LaunchAgent / systemd user service, `agent.ps1` from the Startup folder; on macOS also
  `calendar.swift` compiled at install) → `POST /api/computer`: what's playing, Dock unread counts, away status,
  calendar events (PROTOCOL.md §12). Owner's direction: one install on the computer should feed the desk; prefer reading things
  from the computer over per-service accounts and keys (Spotify/Last.fm/Slack keys are optional extras he won't set).

## Hardware facts
- Pins: MOSI 13, SCLK 14, DC 0, RST 2, CS none; backlight GPIO5 PWM **active-low**; `invertDisplay(true)`.
- Panel looks best with gamma preset 2 (`gtab=2`), sharp text on, vivid colours, ~25% day brightness; cards must be
  pure black (dark greys tint green in RGB565).
- RAM is the constraint (~80 KB total; static RAM 37.96 KB on 1.4.13 (40 bytes under budget), was 42.9 KB on 1.4.1). Memory rules:
  - **String literals live in RAM on the ESP8266.** Web pages are PROGMEM templates (`~key~` placeholders, streamed
    by `sendPage`/`sendTpl`, never built as one big String); use `PSTR()`/`F()`/`snprintf_P` for anything long.
  - Drawing code shares one row buffer (`gRowBuf`); don't add per-function `static` pixel buffers.
  - `firmware/tools/ram_budget.py` fails the build if static RAM (.data+.rodata+.bss) passes the budget (main 38000,
    loader 32000). Raise it only on purpose, with the reason in the commit message.
  - Release check on the real desk, connected to the hub: `/info` `heap` ≥ 12 KB and `maxblk` ≥ 8 KB, weather loads,
    the desk's page opens. The hub's desk page shows memory and flags crashes (`reset` = Exception/Watchdog).
  - Safety net (1.4.4): `maxblk` < 3 KB for 2 min → the desk restarts itself (only after 30 min uptime, no loops).
- One BearSSL TLS session ≈ 25 KB → the firmware never holds two:
  hello (HTTPS) runs before MQTT; pack downloads/OTA stop MQTT first. Measured on the real desk (1.4.1, default 16 KB
  BearSSL RX buffer): ~32 KB free before the hub link, **~2.7 KB free while MQTT/TLS is up** — weather fetches failed.
  1.4.2 uses a 2 KB RX buffer for MQTT (hub caps TLS records at 2 KB, PROTOCOL.md §3): **~17 KB free while
  connected** on 1.4.3, weather works. OTA and pack downloads restart first and download before hello/MQTT (1.4.3);
  the in-place download failed on the real desk. Check `heap` in `/info` or `up/status` after changes.
  - Desk stuck on a firmware whose OTA fails: 4 quick `GET /reboot` (each within 60 s of boot) → SAFE MODE (no hub,
    ~33 KB free) → `curl -F firmware=@firmware/dist/claude-desk.bin http://<ip>/update`. The next boot is SAFE MODE
    again; after 60 s uptime, `/reboot` once more to get back to normal.
- Factory firmware's update page only accepts ≈528 KB → first install uses `claude-desk.bin.gz` or the loader route.

## Owner's setup / current state (Nov 2026)
- Owner: Chris (GitHub `Chrishalaby`), macOS, Claude Code user. Repo: github.com/Chrishalaby/claude-desk (public).
- His desk runs **firmware 1.4.5** (1.4.13 is built: drawings (fill, shapes, undo) and photos/GIFs with keep-on and back-to-clock, the now-playing line, leaving a Wi-Fi without internet), paired on the hub as "Chris"
  (`chris-desk.local`), ~21 KB free while connected, on home Wi-Fi with the hotspot also saved.
  1.0.4 → 1.4.1 by local `/update`; 1.4.1 → 1.4.3 via SAFE MODE (its own OTA failed); later versions by the hub's
  Update button (restart-then-download path, verified on the device).
- Claude Code hooks are installed on his Mac (`~/.claude-desk/hook.py`, token in `config.json`) and reach the hub.
  The old local tracker's launchd job and hooks are gone; its folder `~/Claude/geekmagic/claude-desk/` is unused.
  macOS blocks LAN access for launchd services (Local Network privacy), which is why hooks go to the hub.
- Hub is live at `https://claude-desk.up.railway.app` (Railway project `claude-desk`; MQTT via the TCP proxy, the hub
  hands the endpoint to devices). Phone-first install guide at `/#/install`. The invite code is weak; change
  `HUB_INVITE_CODE` before sharing the hub widely.
- Still to test on the device: 1.4.6 (drawings, now playing), Wi-Fi switching, needs/done cards from a real session,
  a message + reaction between two accounts, remote settings, pack download. Apps against the real services: a real
  calendar feed, GitHub token, Spotify/Last.fm/Slack (need their env vars on Railway), an IMAP account, rain alerts.
- Untested so far: Windows `install.ps1`/`hook.ps1` (written carefully, never executed), the install guide on a real
  phone and on a stock GeekMagic.
- Commercial plans: talking to GeekMagic (Shenzhen Fumantu Technology) about OEM units flashed with this firmware.
  The "Claude" name would have to change (or be cleared with Anthropic) before selling.

## Conventions
- Owner prefers terse answers. Keep personal data (locations, names) out of the public repo.
- Push finished work (signed commits, tests green) straight to `main`; never ask whether to merge. Then watch the
  Railway deploy and verify the live hub.
- Keep `docs/PROTOCOL.md` the single source of truth; update it with any protocol change and keep `npm test` green.
