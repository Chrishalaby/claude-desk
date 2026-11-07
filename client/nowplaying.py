#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = os.path.join(os.path.expanduser("~"), ".claude-desk", "config.json")
OS = "mac" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else ""

MAC_SCRIPT = """tell application "%s"
if player state is playing then
try
set t to current track
return (name of t) & linefeed & (artist of t)
end try
end if
end tell
return ""
"""
MAC_APPS = (("Spotify", "Spotify"), ("Music", "Apple Music"))


def running(name):
    return subprocess.run(["pgrep", "-xq", name], capture_output=True).returncode == 0


def mac():
    error = None
    for proc, label in MAC_APPS:
        if not running(proc):
            continue
        r = subprocess.run(["osascript", "-e", MAC_SCRIPT % proc], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            error = "not_allowed" if "-1743" in r.stderr else "script"
            continue
        title, _, artist = r.stdout.rstrip("\n").partition("\n")
        if title.strip():
            return {"title": title.strip(), "artist": artist.strip(), "app": label}, None
    return None, error


def linux():
    if not shutil.which("playerctl"):
        return None, "no_playerctl"
    r = subprocess.run(["playerctl", "-a", "metadata", "--format", "{{status}}\t{{playerName}}\t{{title}}\t{{artist}}"],
                       capture_output=True, text=True, timeout=10)
    for line in r.stdout.splitlines():
        parts = (line.split("\t") + ["", "", "", ""])[:4]
        if parts[0] == "Playing" and parts[2].strip():
            return {"title": parts[2].strip(), "artist": parts[3].strip(), "app": parts[1].strip().capitalize()}, None
    return None, None


def current():
    try:
        return mac() if OS == "mac" else linux()
    except Exception:
        return None, "script"


def post(cfg, body):
    req = urllib.request.Request(
        cfg["hub"].rstrip("/") + "/api/nowplaying",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["token"]},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def report():
    song, error = current()
    body = {"os": OS, "playing": bool(song), "error": error}
    if song:
        body.update(song)
    return body


def main():
    if not OS:
        return
    if "--once" in sys.argv:
        print(json.dumps(report()))
        return
    last, sent_at, pause_until = None, 0.0, 0.0
    while True:
        now = time.time()
        if now < pause_until:
            time.sleep(min(60, pause_until - now))
            continue
        try:
            with open(CONFIG) as f:
                cfg = json.load(f)
        except Exception:
            time.sleep(60)
            continue
        body = report()
        key = json.dumps(body, sort_keys=True)
        playing = body["playing"]
        if key != last or now - sent_at >= (60 if playing else 600):
            try:
                if post(cfg, body).get("off"):
                    pause_until = now + 300
                last, sent_at = key, now
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    pause_until = now + 600
            except Exception:
                pass
        time.sleep(5 if playing else 60 if body["error"] in ("not_allowed", "no_playerctl") else 10)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
