# claude-desk

Turn a **GeekMagic SmallTV Ultra** (the ~$20 ESP8266 desk clock) into a little desk companion:

- **Clock + weather** for wherever you live (tall clock layout or a clean one, sharp anti-aliased text, Meteocons weather icons).
- **Claude Code status** — a pixel robot that works when Claude works, and a full-screen **NEEDS YOU** card when Claude Code is waiting for a permission (stays until you answer; several sessions stack as "+2 more waiting"), then **DONE**.
- **Moods** — the robot blinks, dozes off when you've been away, and sleeps at night. Optionally **Casper the dog** trots by, naps next to it and sleeps there at night.
- **Friends network** — pair your desk with a small self-hosted hub and send friends messages and reactions (👋 👍 😂 ☕ 🔥 ❤️ 🤗 😘 🌙 🥺) that pop up on their desk instantly.

```
Claude Code ── hook ──▶ hub (Railway) ── MQTT/TLS ──▶ your desk
phone / browser ── web app ──▶ hub ──▶ your friends' desks
```

Works with Claude Code on **macOS, Linux and Windows**. No local daemon: a tiny hook script posts trimmed events (never tool output or file contents) to your hub.

## What's in here

| folder | what |
|---|---|
| `firmware/` | ESP8266 firmware (PlatformIO). Prebuilt images in `firmware/dist/`. |
| `hub/` | The hub: Node/TypeScript web app + REST API + MQTT broker. Deploys to Railway in a few clicks. |
| `client/` | Claude Code hook + installers (`install.sh` for macOS/Linux, `install.ps1` for Windows). |
| `docs/` | [`INSTALL.md`](docs/INSTALL.md) (step by step — you can hand it to your AI assistant), [`PROTOCOL.md`](docs/PROTOCOL.md). |

## Quick start

1. **Hub** — one person in the group deploys it ([hub/README.md](hub/README.md)); everyone else just signs up on it.
2. **Desk** — flash the firmware from the device's own update page (no cable), set Wi-Fi, location and the hub address, then pair it with the 6-digit code it shows.
3. **Claude Code** — copy the one-line installer from the hub's *Claude Code* page.

Full instructions: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Safety nets

- The update page (`http://<desk>/update`) is always available, in every mode.
- If the firmware crashes 4 times in a row it boots into a minimal safe mode with Wi-Fi + update only.
- No saved Wi-Fi in range → it opens its own setup network `claude-desk-setup` (portal at `192.168.4.1`).
- Up to 4 Wi-Fi networks are remembered; it joins whichever is in range (e.g. home + phone hotspot).

## Credits

Weather icons: [Meteocons](https://github.com/basmilius/weather-icons) by Bas Milius (MIT). Font: [Inter](https://rsms.me/inter/) (SIL OFL). Display driver: TFT_eSPI. Pinout reference: [bvweerd/geekmagic-tv-esp8266](https://github.com/bvweerd/geekmagic-tv-esp8266).
Reaction emoji: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) by Microsoft (MIT). Robot and Casper pixel art are original. Not affiliated with GeekMagic, Microsoft or Anthropic.

## License

MIT
