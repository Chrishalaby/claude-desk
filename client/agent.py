#!/usr/bin/env python3
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

DIR = os.path.join(os.path.expanduser("~"), ".claude-desk")
CONFIG = os.path.join(DIR, "config.json")
CALENDAR = os.path.join(DIR, "calendar.json")
DOCK = os.path.join(DIR, "badges.json")
OS = "mac" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else ""
AWAY_SECS = 600

PLAYER_SCRIPT = """tell application "%s"
if player state is playing then
try
set t to current track
return (name of t) & linefeed & (artist of t)
end try
end if
end tell
return ""
"""
TABS_SCRIPT = """tell application "%s"
set out to ""
repeat with w in windows
repeat with t in tabs of w
set out to out & (URL of t) & tab & (%s of t) & linefeed
end repeat
end repeat
return out
end tell
"""
PLAYERS = (("Spotify", "Spotify"), ("Music", "Apple Music"))
BROWSERS = (("Google Chrome", "title"), ("Arc", "title"), ("Microsoft Edge", "title"), ("Brave Browser", "title"), ("Safari", "name"))
SITES = {
    "soundcloud.com": "SoundCloud", "music.apple.com": "Apple Music", "twitch.tv": "Twitch", "netflix.com": "Netflix",
    "tidal.com": "Tidal", "deezer.com": "Deezer", "vimeo.com": "Vimeo", "primevideo.com": "Prime Video",
    "disneyplus.com": "Disney+", "max.com": "Max", "open.qobuz.com": "Qobuz", "pandora.com": "Pandora",
}


def run(args, timeout=15):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None


def running(name):
    r = run(["pgrep", "-xq", name])
    return bool(r) and r.returncode == 0


def audio_apps():
    r = run(["pmset", "-g", "assertions"])
    pids = sorted(set(re.findall(r"audio[^\n]*\n\s*Created for PID: (\d+)", r.stdout if r else "")))
    if not pids:
        return set()
    r = run(["ps", "-o", "comm=", "-p", ",".join(pids)])
    apps = set()
    for path in (r.stdout.splitlines() if r else []):
        m = re.search(r"/([^/]+)\.app/", path)
        if m:
            apps.add(m.group(1))
        elif "com.apple.WebKit" in path:
            apps.add("Safari")
    return apps


def site_song(url, title):
    host = re.sub(r"^[a-z]+://", "", url.strip().lower()).split("/")[0].split(":")[0]
    host = host[4:] if host.startswith("www.") else host
    t = re.sub(r"^\(\d+\)\s*", "", title.strip())
    if host == "open.spotify.com":
        if " • " not in t:
            return None
        name, _, artist = t.partition(" • ")
        return 4, {"title": name.strip(), "artist": artist.strip(), "app": "Spotify"}
    if host == "music.youtube.com":
        t = re.sub(r"\s*[-|]\s*YouTube Music$", "", t)
        return (3, {"title": t, "artist": "YouTube Music", "app": "YouTube Music"}) if t and t != "YouTube Music" else None
    if host in ("youtube.com", "m.youtube.com", "youtu.be") and ("/watch" in url or "/shorts/" in url or host == "youtu.be"):
        t = re.sub(r"\s*-\s*YouTube$", "", t)
        return (2, {"title": t, "artist": "YouTube", "app": "YouTube"}) if t else None
    for domain, site in SITES.items():
        if host == domain or host.endswith("." + domain):
            t = re.sub(r"\s*(?:[-|–·]\s*%s|on %s)\s*$" % (re.escape(site), re.escape(site)), "", t, flags=re.I).strip("▶ ").strip()
            t = re.sub(r"^Stream ", "", t)
            return 1, {"title": t or site, "artist": site if t and t != site else "", "app": site}
    return None


def pick_tab(listing):
    best = None
    for line in listing.splitlines():
        url, _, title = line.partition("\t")
        hit = site_song(url, title) if url else None
        if hit and (best is None or hit[0] > best[0]):
            best = hit
    return best[1] if best else None


def mac_media():
    playing = audio_apps()
    if not playing:
        return None, None
    error = None
    for proc, label in PLAYERS:
        if proc not in playing:
            continue
        r = run(["osascript", "-e", PLAYER_SCRIPT % proc], 180)
        if r is None or r.returncode != 0:
            error = "not_allowed" if r and "-1743" in r.stderr else "script"
            continue
        title, _, artist = r.stdout.rstrip("\n").partition("\n")
        if title.strip():
            return {"title": title.strip(), "artist": artist.strip(), "app": label}, None
    for app, field in BROWSERS:
        if app not in playing or not running(app):
            continue
        r = run(["osascript", "-e", TABS_SCRIPT % (app, field)], 180)
        if r is None or r.returncode != 0:
            error = "not_allowed" if r and "-1743" in r.stderr else error or "script"
            continue
        song = pick_tab(r.stdout)
        if song:
            return song, None
    return None, error


def linux_media():
    if not shutil.which("playerctl"):
        return None, "no_playerctl"
    r = run(["playerctl", "-a", "metadata", "--format", "{{status}}\t{{playerName}}\t{{title}}\t{{artist}}"])
    for line in (r.stdout.splitlines() if r else []):
        parts = (line.split("\t") + ["", "", "", ""])[:4]
        if parts[0] == "Playing" and parts[2].strip():
            return {"title": parts[2].strip(), "artist": parts[3].strip(), "app": parts[1].strip().capitalize()}, None
    return None, None


def badges():
    r = run(["lsappinfo", "list"])
    asns, cur = [], None
    for line in (r.stdout.splitlines() if r else []):
        m = re.match(r'\s*\d+\) ".*" (ASN:[0-9a-fx-]+):', line)
        if m:
            cur = m.group(1)
        elif cur and 'type="Foreground"' in line:
            asns.append(cur)
            cur = None
    if not asns:
        return {}
    r = run(["lsappinfo", "-all", "info", "-only", "StatusLabel", "-only", "name"] + asns)
    out = {}
    for block in (r.stdout.split("---") if r else []):
        name = re.search(r'"LSDisplayName"="([^"]*)"', block)
        label = re.search(r'"StatusLabel"=\{ "label"="([^"]*)" \}', block)
        if name and label and label.group(1).strip():
            digits = re.sub(r"\D", "", label.group(1))
            out[name.group(1).strip("‎‏ ")] = int(digits) if digits else -1
    return out


def dock_badges():
    try:
        with open(DOCK) as f:
            d = json.load(f)
    except Exception:
        return None, None
    if not isinstance(d, dict) or time.time() - float(d.get("at") or 0) > 90:
        return None, None
    if not d.get("ok"):
        return str(d.get("error") or "not_allowed"), None
    return "ok", {str(k): int(v) for k, v in (d.get("badges") or {}).items()}


def idle_secs():
    if OS == "mac":
        r = run(["ioreg", "-c", "IOHIDSystem", "-d", "4"])
        m = re.search(r'"HIDIdleTime" = (\d+)', r.stdout if r else "")
        return int(m.group(1)) // 1000000000 if m else None
    if shutil.which("xprintidle"):
        r = run(["xprintidle"])
        if r and r.stdout.strip().isdigit():
            return int(r.stdout.strip()) // 1000
    return None


def calendar():
    try:
        with open(CALENDAR) as f:
            c = json.load(f)
    except Exception:
        return None, None
    if not isinstance(c, dict):
        return None, None
    if time.time() - float(c.get("at") or 0) > 1800:
        return "stale", None
    if not c.get("ok"):
        return str(c.get("error") or "not_allowed"), None
    return "ok", c.get("events") or []


class Agent:
    def __init__(self):
        self.badges, self.badges_at = {}, 0.0
        self.idle, self.idle_at = None, 0.0

    def snapshot(self, now):
        song, error = (mac_media() if OS == "mac" else linux_media()) if OS else (None, None)
        body = {"os": OS, "playing": bool(song), "error": error}
        if song:
            body.update(song)
        if OS == "mac":
            if now - self.badges_at >= 15:
                self.badges, self.badges_at = badges(), now
            status, from_dock = dock_badges()
            body["badges"] = {**self.badges, **(from_dock or {})}
            if status:
                body["dock"] = status
        if now - self.idle_at >= 30:
            self.idle, self.idle_at = idle_secs(), now
        if self.idle is not None:
            body["away"] = self.idle >= AWAY_SECS
            body["idle"] = self.idle
        status, events = calendar()
        if status:
            body["calendar"] = status
        if events is not None:
            body["events"] = events
        return body


def post(cfg, body):
    req = urllib.request.Request(
        cfg["hub"].rstrip("/") + "/api/computer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["token"]},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def main():
    if not OS:
        return
    agent = Agent()
    if "--once" in sys.argv:
        print(json.dumps(agent.snapshot(time.time()), indent=1, ensure_ascii=False))
        return
    last, sent_at, events_key, events_at, pause_until = None, 0.0, None, 0.0, 0.0
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
        body = agent.snapshot(now)
        events = body.pop("events", None)
        ekey = hashlib.sha1(json.dumps(events, sort_keys=True).encode()).hexdigest() if events is not None else None
        key = json.dumps({k: v for k, v in body.items() if k != "idle"}, sort_keys=True)
        send_events = events is not None and (ekey != events_key or now - events_at >= 600)
        if send_events:
            body["events"] = events
        if key != last or send_events or now - sent_at >= (60 if body["playing"] else 120):
            try:
                post(cfg, body)
                last, sent_at = key, now
                if send_events:
                    events_key, events_at = ekey, now
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    pause_until = now + 600
            except Exception:
                pass
        time.sleep(5 if body["playing"] else 10)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
