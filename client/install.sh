#!/usr/bin/env bash
# claude-desk client installer (macOS / Linux)
#   curl -fsSL https://<your-hub>/install.sh | bash -s -- <hook-token>
# Installs ~/.claude-desk/hook.py, writes ~/.claude-desk/config.json and adds the hooks to
# ~/.claude/settings.json (backed up first; safe to re-run; removes older claude-desk entries).
set -euo pipefail

HUB="${CLAUDE_DESK_HUB:-__HUB_URL__}"
TOKEN="${1:-${CLAUDE_DESK_TOKEN:-}}"
DIR="$HOME/.claude-desk"
SETTINGS="$HOME/.claude/settings.json"

say() { printf '\033[1;38;5;173m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

case "$HUB" in *"__HUB""_URL__"*) die "Hub URL unknown. Run it from your hub: curl -fsSL https://<hub>/install.sh | bash -s -- <token>  (or set CLAUDE_DESK_HUB)";; esac
[ -n "$TOKEN" ] || die "Missing token. Copy the command from your hub's 'Claude Code' page."
command -v python3 >/dev/null 2>&1 || die "python3 is required (macOS: run 'xcode-select --install')."
command -v curl >/dev/null 2>&1 || die "curl is required."
HUB="${HUB%/}"

say "Installing hook into $DIR"
mkdir -p "$DIR"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC" ] && [ -f "$SRC/hook.py" ]; then cp "$SRC/hook.py" "$DIR/hook.py"
else curl -fsSL "$HUB/client/hook.py" -o "$DIR/hook.py"; fi
chmod 755 "$DIR/hook.py"

HUB="$HUB" TOKEN="$TOKEN" python3 - "$DIR/config.json" <<'PY'
import json, os, sys
with open(sys.argv[1], "w") as f:
    json.dump({"hub": os.environ["HUB"], "token": os.environ["TOKEN"]}, f, indent=2)
PY
chmod 600 "$DIR/config.json"

say "Adding hooks to $SETTINGS"
HOOK_CMD="python3 \"$DIR/hook.py\"" python3 - "$SETTINGS" <<'PY'
import json, os, shutil, sys, time
path, cmd = sys.argv[1], os.environ["HOOK_CMD"]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        txt = f.read().strip()
    cfg = json.loads(txt) if txt else {}
    shutil.copy(path, path + time.strftime(".bak-claude-desk-%Y%m%d%H%M%S"))
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
hooks = cfg.setdefault("hooks", {})
def ours(group):  # any earlier claude-desk hook (this one or the old local tracker)
    return any("claude-desk" in h.get("command", "") for h in group.get("hooks", []))
for ev in list(hooks):
    hooks[ev] = [g for g in hooks[ev] if not ours(g)]
    if not hooks[ev]:
        del hooks[ev]
events = {"UserPromptSubmit": None, "PermissionRequest": "*", "PostToolUse": "*",
          "Notification": "*", "Stop": None, "SessionEnd": None}
for ev, matcher in events.items():
    group = {"hooks": [{"type": "command", "command": cmd, "async": True, "timeout": 5}]}
    if matcher:
        group = {"matcher": matcher, **group}
    hooks.setdefault(ev, []).append(group)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY

# retire the old local tracker (early claude-desk versions ran a launchd service)
for p in "$HOME"/Library/LaunchAgents/com.*.claude-desk.plist; do
  [ -f "$p" ] || continue
  say "Removing old local service $(basename "$p")"
  launchctl unload "$p" 2>/dev/null || true
  rm -f "$p"
done

fetch() {
  if [ -n "$SRC" ] && [ -f "$SRC/$1" ]; then cp "$SRC/$1" "$DIR/$1"
  else curl -fsSL "$HUB/client/$1" -o "$DIR/$1"; fi
}

agent_plist() {
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$2</string>
  <key>ProgramArguments</key><array>$3</array>
  $4
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$1" 2>/dev/null || launchctl load -w "$1" 2>/dev/null
}

agent_mac() {
  local la="$HOME/Library/LaunchAgents" old="$HOME/Library/LaunchAgents/com.claude-desk.nowplaying.plist"
  mkdir -p "$la"
  if [ -f "$old" ]; then launchctl bootout "gui/$(id -u)" "$old" 2>/dev/null || true; rm -f "$old" "$DIR/nowplaying.py"; fi
  agent_plist "$la/com.claude-desk.agent.plist" com.claude-desk.agent \
    "<string>$(command -v python3)</string><string>$DIR/agent.py</string>" \
    "<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>" || return 1
  say "Your computer now feeds the desk: what's playing (Spotify, Apple Music, YouTube and more in"
  say "Chrome, Safari, Arc, Edge, Brave), unread counts from Dock apps, and when you're away."
  say "macOS asks once per app to let Python read it (Spotify, Music, your browser). Click Allow."
  if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1 && fetch calendar.swift; then
    cat > "$DIR/calendar-Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.claude-desk.calendar</string>
<key>CFBundleName</key><string>Claude Desk Calendar</string>
<key>NSCalendarsFullAccessUsageDescription</key><string>Shows your next meeting on your desk.</string>
<key>NSCalendarsUsageDescription</key><string>Shows your next meeting on your desk.</string>
</dict></plist>
PLIST
    say "Building the calendar reader (a few seconds)"
    if xcrun swiftc -O -swift-version 5 -o "$DIR/claude-desk-calendar" "$DIR/calendar.swift" \
         -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/calendar-Info.plist" >/dev/null 2>&1 \
       && codesign --force -s - --identifier com.claude-desk.calendar "$DIR/claude-desk-calendar" >/dev/null 2>&1 \
       && agent_plist "$la/com.claude-desk.calendar.plist" com.claude-desk.calendar \
            "<string>$DIR/claude-desk-calendar</string><string>$DIR/calendar.json</string>" \
            "<key>StartInterval</key><integer>300</integer>"; then
      say "Calendar: macOS asks to let Claude Desk Calendar see your calendars. Click Allow."
    else
      say "Couldn't build the calendar reader; your desk can still use a calendar link (Apps → Calendar)."
    fi
  else
    say "Calendar from this Mac needs the command line tools (xcode-select --install), then run this again."
  fi
}

agent_linux() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 || return 1
  local units="$HOME/.config/systemd/user"
  mkdir -p "$units"
  if [ -f "$units/claude-desk-nowplaying.service" ]; then
    systemctl --user disable --now claude-desk-nowplaying.service >/dev/null 2>&1 || true
    rm -f "$units/claude-desk-nowplaying.service" "$DIR/nowplaying.py"
  fi
  cat > "$units/claude-desk-agent.service" <<UNIT
[Unit]
Description=claude-desk computer agent

[Service]
ExecStart=$(command -v python3) $DIR/agent.py
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now claude-desk-agent.service >/dev/null 2>&1 || return 1
  systemctl --user restart claude-desk-agent.service >/dev/null 2>&1 || true
  say "Your computer now feeds the desk: what's playing and when you're away."
  command -v playerctl >/dev/null 2>&1 || say "Install playerctl so it can see your player (e.g. sudo apt install playerctl)."
  command -v xprintidle >/dev/null 2>&1 || say "Install xprintidle for the away status (e.g. sudo apt install xprintidle)."
}

if [ "${CLAUDE_DESK_NO_AGENT:-${CLAUDE_DESK_NO_MUSIC:-}}" != "1" ]; then
  if fetch agent.py; then
    chmod 755 "$DIR/agent.py"
    case "$(uname -s)" in
      Darwin) agent_mac || say "Couldn't start the computer agent (launchctl refused). The hook still works." ;;
      Linux) agent_linux || say "The computer agent needs a systemd user session; skipped. The hook still works." ;;
    esac
  fi
fi

say "Testing connection to $HUB"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$HUB/api/hook" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"e":"Stop","sid":"install-test","project":"claude-desk"}' || true)
if [ "$code" = "200" ]; then
  say "Done. Your desk should show DONE · claude-desk for a few seconds."
  say "Restart any open Claude Code sessions to pick up the hooks."
else
  die "Hub answered HTTP $code. Check the token (regenerate it on the hub's Claude Code page) and re-run."
fi
