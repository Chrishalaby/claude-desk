#!/usr/bin/env python3
"""claude-desk hook (macOS / Linux).

Claude Code runs this for each hook event and pipes the event JSON on stdin. We keep only the
few fields the hub needs (never tool output or file contents), POST them to your hub, and exit.
It never prints, never fails and gives up after 2 s, so it can't slow Claude Code down.
Config: ~/.claude-desk/config.json  {"hub": "https://...", "token": "..."}
"""
import json
import os
import sys
import urllib.request


def trim(ev):
    ti = ev.get("tool_input") or {}
    if not isinstance(ti, dict):
        ti = {}
    detail = ti.get("command") or ti.get("file_path") or ti.get("url") or ti.get("pattern") or ""
    if ti.get("file_path"):
        detail = os.path.basename(str(detail))
    detail = " ".join(str(detail).split())[:60]
    cwd = str(ev.get("cwd") or "").rstrip("/\\")
    out = {
        "e": ev.get("hook_event_name", ""),
        "sid": ev.get("session_id", ""),
        "project": os.path.basename(cwd.replace("\\", "/")) or "claude code",
    }
    if ev.get("tool_name"):
        out["tool"] = ev["tool_name"]
        out["detail"] = detail
    if ev.get("tool_use_id"):
        out["tid"] = ev["tool_use_id"]
    if out["e"] == "Notification":
        out["ntype"] = ev.get("notification_type") or ""
        out["msg"] = str(ev.get("message") or "")[:80]
    return out


def main():
    try:
        ev = json.load(sys.stdin)
        with open(os.path.join(os.path.expanduser("~"), ".claude-desk", "config.json")) as f:
            cfg = json.load(f)
        req = urllib.request.Request(
            cfg["hub"].rstrip("/") + "/api/hook",
            data=json.dumps(trim(ev)).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["token"]},
        )
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
