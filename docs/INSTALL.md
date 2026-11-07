# Installing claude-desk

**On a phone?** Every hub has the same steps as a tap-through guide at `https://<hub>/#/install` (linked from the
sign-in page and from Devices). It needs no computer: download the file on the phone, upload it on the desk's update
page, then one tap connects the desk to the hub.

This guide is written so a person **or an AI coding assistant** can follow it top to bottom.
If you're an AI assistant helping someone: do the steps on their computer where you can, and ask them to do the
physical/browser steps (marked **👤 you**). Never ask for or store their Wi-Fi password or hub password yourself —
they type those into the device/hub pages directly.

You need:
- A **GeekMagic SmallTV Ultra** (ESP8266 model, 240×240 screen). *The "Pro" (ESP32) is a different board and is not supported.*
- The **hub address** of your group (e.g. `https://our-desks.up.railway.app`) and its invite code, from whoever runs it.
  Running the hub yourself? See [`hub/README.md`](../hub/README.md) first.
- For the Claude Code part: Claude Code on macOS, Linux or Windows.

---

## 1. Put the desk on your Wi-Fi (factory firmware) — 👤 you

1. Plug the GeekMagic in. On first start it opens a Wi-Fi network (usually `GIFTV` / `SmallTV`). Join it with your phone,
   open `192.168.4.1`, choose your Wi-Fi and enter its password.
2. The screen then shows its IP address (e.g. `192.168.1.107`). Write it down.

## 2. Flash the claude-desk firmware (no cable)

Files are in [`firmware/dist/`](../firmware/dist/):
- `claude-desk.bin.gz` — full firmware, compressed (≈410 KB)
- `claude-desk-loader.bin` — small loader (≈400 KB), only needed if the first option is refused
- `claude-desk.bin` — full firmware, uncompressed (for updates once claude-desk is running)

Steps:
1. Download `claude-desk.bin.gz` to the computer (same Wi-Fi as the desk).
2. Open `http://<desk-ip>/update` in a browser, choose the file, press **Update**, wait ~30 s.
   - AI assistants can do it from a shell:
     `curl -F "firmware=@claude-desk.bin.gz" http://<desk-ip>/update`
3. If the page says *Not enough space* or the update fails: upload `claude-desk-loader.bin` the same way. The desk reboots
   showing **LOADER** and its IP; then open `http://<desk-ip>/update` again and upload `claude-desk.bin`.
4. The desk reboots into claude-desk ("CONNECTING…", then the clock). It keeps your Wi-Fi.
   - If it shows **SETUP** instead: join the Wi-Fi `claude-desk-setup` with your phone, open `192.168.4.1`, pick your
     network and enter the password.

From now on the desk has its own local address, shown on its screen while it starts (under the IP):
**`http://claude-desk-<id>.local`**, where `<id>` is the end of its chip id (e.g. `claude-desk-1a2b3c.local`). Once
it's paired with a hub it is renamed after your hub username: **`http://<username>-desk.local`** (a second desk on
the same account becomes `<username>-desk-2.local`). The IP always works too, and with several desks on one Wi-Fi each
keeps its own name. Firmware updates go through `http://<desk address>/update` with `claude-desk.bin`.

## 3. Desk settings — 👤 you (browser)

Open the desk's address (`http://claude-desk-<id>.local` or its IP):
1. **Location** — type your city in the search box, pick it, press **Save**. Weather and timezone (incl. daylight saving)
   follow the location automatically.
2. **Friends hub** — paste the hub address (e.g. `our-desks.up.railway.app`), press **Save**. The desk reboots and shows
   **PAIR THIS DESK** with a 6-digit code.
3. Optional: layout (tall clock / clean), brightness day/night, night hours, colours, *Casper the dog visits*.
4. **Wi-Fi networks** (`/wifi`) — add a second network (e.g. your phone hotspot) so it keeps working when the home Wi-Fi is down.

## 4. Hub account + pairing — 👤 you (phone or browser)

1. Open the hub address, **register** (invite code from whoever runs the hub), sign in.
2. **Devices → Pair**: enter the 6-digit code from the desk and give it a name. The desk switches back to the clock and
   takes its new local address, `http://<username>-desk.local` (shown on the desk's page in the hub).
3. **Friends → Add**: enter a friend's username. They accept on their side.
4. Pick a friend on **Home** to send a message (≤100 characters) or a reaction. It pops up on their desk within a second.

## 5. Claude Code status

On the hub, open **Apps → Claude Code**. It shows your personal hook token and a one-line installer.

**macOS / Linux** (needs `python3` and `curl`; on macOS run `xcode-select --install` once if python3 is missing):
```bash
curl -fsSL https://<hub>/install.sh | bash -s -- <your-token>
```

**Windows** (PowerShell):
```powershell
$env:CLAUDE_DESK_TOKEN='<your-token>'; irm https://<hub>/install.ps1 | iex
```

What the installer does (safe to re-run):
- puts the hook in `~/.claude-desk/` (`hook.py` or `hook.ps1`) and its config in `~/.claude-desk/config.json`;
- adds hooks for `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd` to
  `~/.claude/settings.json` (backing it up first, keeping your other hooks, replacing older claude-desk entries);
- sends a test event — the desk shows **DONE · claude-desk** for a few seconds;
- starts a small background agent so your computer feeds the desk (turn each part on or off under **Apps → Your
  computer**; install with `CLAUDE_DESK_NO_AGENT=1` to skip it):
  - **what's playing** (title and artist only): on a Mac the Spotify and Apple Music apps and YouTube, YouTube Music,
    Spotify, SoundCloud and other media sites in Chrome, Safari, Arc, Edge or Brave (macOS asks once per app to let
    Python read it: click Allow; Firefox isn't readable); on Windows any app or browser; on Linux through `playerctl`;
  - **unread counts** (Mac): the red badges on Dock apps (Slack, Mail, Messages, WhatsApp, Discord, Teams…) become a
    card when they go up; no permission needed;
  - **calendar**: on a Mac every calendar added to the Calendar app (iCloud, Google, Outlook…), through a small reader
    the installer compiles (needs the command line tools; macOS asks once to let *Claude Desk Calendar* see your
    calendars); on Windows the classic Outlook calendar while Outlook is open;
  - **away status**: after 10 minutes without keyboard or mouse (or when the computer sleeps) your friends see you're
    away (Linux needs `xprintidle`).

Then **restart open Claude Code sessions**. The hooks run asynchronously with a 2-second timeout and never print, so they
can't slow Claude down. Only the event name, session id, project folder name, tool name and a short detail (command /
file name, ≤60 chars) leave your machine.

To remove: delete the claude-desk entries from `~/.claude/settings.json` (or restore the `.bak-claude-desk-*` backup) and
the `~/.claude-desk` folder. Stop the agent first: macOS `launchctl bootout gui/$(id -u)
~/Library/LaunchAgents/com.claude-desk.agent.plist` (and `com.claude-desk.calendar.plist`) and delete those files;
Linux `systemctl --user disable --now claude-desk-agent`; Windows delete `claude-desk-agent` from the Startup folder
(`shell:startup`) and sign out.


## 6. More apps (optional)

The same **Apps** tab can put more on the desk, all fetched by the hub (the desk itself needs nothing extra):
- **Canvas**: draw on your desk from your phone. From a friend's chat, ✏️ draws on both desks at once, and they can
  join in and draw with you.
- **Now playing**: the song under the clock. It comes from your computer automatically (section 5); for music on your
  phone or a speaker, link your app to Last.fm.
- **Timer**: a countdown under the clock and a card when it ends.
- **Reminders**: "drink water every hour, 9 to 6 on weekdays", or once a day at a set time.
- **Rain alerts**: a card about 30 minutes before rain starts where your desk is.
- **Calendar**: paste your calendar's private iCal link; you get a card before each event and the next one under the clock.
- **GitHub**: a card for review requests, mentions and build results (a token with only the *notifications* scope).
- **Stocks & crypto**: a card when a price crosses your level or moves a lot in a day.
- **Email**: a card for new mail (Gmail, iCloud, Yahoo, Fastmail or any IMAP server, with an app password).
- **Slack**: a card when someone @mentions you.
- **Webhook**: your private URL; anything that can call a URL (Zapier, n8n, GitHub Actions, Home Assistant, iPhone
  Shortcuts, scripts) can show a card.

**Wi-Fi**: on the desk's page in the hub, *Wi-Fi networks* lists what the desk has saved, finds networks near it and
adds or removes them from anywhere (firmware 1.4.5 or newer).

---

## Troubleshooting

| symptom | fix |
|---|---|
| Desk shows **SETUP** | No saved Wi-Fi in range. Join `claude-desk-setup`, open `192.168.4.1`, add a network. Saved networks are kept. |
| Desk shows **SAFE MODE** | The firmware crashed repeatedly. Open `http://<ip>/update` and upload `claude-desk.bin` again. |
| Settings page: *this desk was removed on the hub* | Clear the hub address, save, set it again, re-pair. |
| Weather says *Set your location* | Use the city search on the settings page and press Save. |
| The desk's `.local` address doesn't resolve (some Windows/Android setups) | Use the IP shown on the desk's screen at start-up or on the hub's Devices page. |
| Claude status doesn't show | Re-run the installer, restart Claude Code, check the hub's Devices page shows the desk as online. |
| Factory update page refuses the file | Use the two-step loader route in section 2. |
