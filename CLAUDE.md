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
  service (new services can't use `hub/railway.json`; it is no longer read). The Dockerfile installs python3/make/g++
  because better-sqlite3 13 compiles from source.
- `client/` hook (`hook.py` macOS/Linux, `hook.ps1` Windows) + installers; the hub serves them with `__HUB_URL__` replaced
  (first occurrence only — keep the placeholder's first occurrence as the value).

## Hardware facts
- Pins: MOSI 13, SCLK 14, DC 0, RST 2, CS none; backlight GPIO5 PWM **active-low**; `invertDisplay(true)`.
- Panel looks best with gamma preset 2 (`gtab=2`), sharp text on, vivid colours, ~25% day brightness; cards must be
  pure black (dark greys tint green in RGB565).
- RAM is the constraint (~80 KB total; ~41 KB static). One BearSSL TLS session ≈ 25 KB → the firmware never holds two:
  hello (HTTPS) runs before MQTT; pack downloads/OTA stop MQTT first. **TLS heap on the real device is still unmeasured**
  — check `heap` in `up/status` / `/info` after the first hub connection. Plan B if too tight: plain MQTT (would need a
  hub listener + doc change).
- Factory firmware's update page only accepts ≈528 KB → first install uses `claude-desk.bin.gz` or the loader route.

## Owner's setup / current state (Nov 2026)
- Owner: Chris (GitHub `Chrishalaby`), macOS, Claude Code user. Repo: github.com/Chrishalaby/claude-desk (public).
- His desk currently runs **firmware 1.0.4** (before Wi-Fi list / Casper / hub support) and has been offline because his
  home Wi-Fi is down. 1.0.4 only knows one network; to move it to his phone hotspot: power-cycle → `claude-desk-setup`
  AP → 192.168.4.1 → pick hotspot (this replaces the home network; re-add it later at `/wifi` on ≥1.2).
  Then upload `firmware/dist/claude-desk.bin` to `http://<ip>/update` (OTA from 1.0.x accepts the full image).
  Home LAN IP was 192.168.1.107; mDNS name `claude-desk.local` (1.0–1.4.0; per-desk names from 1.4.1).
- His Mac still has the **old local tracker** from before the hub (`~/Claude/geekmagic/claude-desk/`, launchd
  `com.chris.claude-desk`, hooks pointing at `.../claude-desk/hook.sh`). Running the hub's `install.sh` removes both.
  Note: macOS blocks LAN access for launchd services (Local Network privacy) — that's why hooks now go to the hub.
- Hub is live at `https://claude-desk.up.railway.app` (Railway project `claude-desk`; MQTT via the TCP proxy, the hub
  hands the endpoint to devices). Next: register (invite code), flash desk to 1.4.1, set hub address on the desk, pair,
  install hooks with the token, test: needs/done cards, a message + reaction between two accounts, remote settings,
  pack download (Fluent/Twemoji/Noto), OTA button.
- Untested so far: Windows `install.ps1`/`hook.ps1` (written carefully, never executed), TLS on device,
  pack download and OTA on device (host-tested pack format only).

## Conventions
- Owner prefers terse answers. Keep personal data (locations, names) out of the public repo.
- Keep `docs/PROTOCOL.md` the single source of truth; update it with any protocol change and keep `npm test` green.
