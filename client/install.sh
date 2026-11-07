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

music_mac() {
  local plist="$HOME/Library/LaunchAgents/com.claude-desk.nowplaying.plist" py
  py="$(command -v python3)"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude-desk.nowplaying</string>
  <key>ProgramArguments</key><array><string>$py</string><string>$DIR/nowplaying.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null || return 1
  say "Now playing is on: what plays in Spotify or Apple Music shows on your desk."
  say "The first time a song plays, macOS asks to let Python control the app. Click Allow."
}

music_linux() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 || return 1
  local unit="$HOME/.config/systemd/user/claude-desk-nowplaying.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=claude-desk now playing

[Service]
ExecStart=$(command -v python3) $DIR/nowplaying.py
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload && systemctl --user enable --now claude-desk-nowplaying.service >/dev/null 2>&1 || return 1
  systemctl --user restart claude-desk-nowplaying.service >/dev/null 2>&1 || true
  say "Now playing is on: what plays on this computer shows on your desk."
  command -v playerctl >/dev/null 2>&1 || say "It needs playerctl to read the player (e.g. sudo apt install playerctl)."
}

if [ "${CLAUDE_DESK_NO_MUSIC:-}" != "1" ]; then
  if [ -n "$SRC" ] && [ -f "$SRC/nowplaying.py" ]; then cp "$SRC/nowplaying.py" "$DIR/nowplaying.py"
  else curl -fsSL "$HUB/client/nowplaying.py" -o "$DIR/nowplaying.py" || true; fi
  if [ -f "$DIR/nowplaying.py" ]; then
    chmod 755 "$DIR/nowplaying.py"
    case "$(uname -s)" in
      Darwin) music_mac || say "Couldn't start now playing (launchctl refused). The hook still works." ;;
      Linux) music_linux || say "Now playing needs a systemd user session; skipped. The hook still works." ;;
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
