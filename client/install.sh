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
