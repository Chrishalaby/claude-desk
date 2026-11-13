import crypto from "node:crypto";
import dns from "node:dns";
import ical from "node-ical";
import { ImapFlow } from "imapflow";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { FetchError, isPrivateAddress, normalizeUrl, safeFetch } from "./net.js";
import { HttpError, type NextUp, type Service } from "./service.js";
import { hhmm, isValidTz, oneLine, trunc } from "./util.js";

export const MAX_FEEDS = 5;
export const MAX_SYMBOLS = 10;
export const MAX_TIMERS = 10;
export const CALENDAR_EVERY_SECS = 10 * 60;
export const STOCKS_EVERY_SECS = 5 * 60;
export const GITHUB_REASONS = ["review_requested", "mention", "ci_activity", "assign", "comment"] as const;
type Reason = (typeof GITHUB_REASONS)[number];
const REASON_TITLE: Record<string, string> = {
  review_requested: "Review requested", mention: "Mentioned", team_mention: "Mentioned", ci_activity: "CI",
  assign: "Assigned", comment: "New comment",
};
const SYMBOL_RE = /^[A-Z0-9.\-=^]{1,15}$/;

interface CalEvent { key: string; start: number; end: number; title: string; location: string }
interface CalendarConfig { feeds: string[]; remind: number; showNext: boolean }
interface CalendarState { feeds: { ok: boolean; error: string | null; at: number; count: number }[]; reminded: string[] }
interface GithubConfig { token: string; login: string; reasons: Record<Reason, boolean> }
interface GithubState { since: number; lastModified: string | null; seen: string[]; interval: number; ok: boolean; error: string | null; at: number }
interface StockItem { symbol: string; above: number | null; below: number | null; move: number | null }
interface StocksConfig { items: StockItem[] }
interface Quote { price: number; prev: number; currency: string; at: number }
interface MusicConfig { clock: boolean; cards: boolean }
interface SpotifyConfig extends MusicConfig { refresh: string; access: string; exp: number; name: string }
interface LastfmConfig extends MusicConfig { user: string }
interface ComputerConfig extends MusicConfig { off: boolean; calendar?: boolean; presence?: boolean; muted?: string[] }
interface ComputerState {
  at: number; app: string; os: string; error: string | null;
  badges?: Record<string, number>; known?: string[]; away?: boolean; awaySince?: number; cal?: string | null; dock?: string | null;
}
export const PRESENCE_STALE_SECS = 300;
const DEFAULT_MUTED = ["App Store", "System Settings", "System Preferences"];
const COMMON_BADGE_APPS = ["WhatsApp", "Slack", "Discord", "Teams", "Telegram", "Messenger", "Gmail", "Outlook"];
const BADGE_COLOR: Record<string, string> = {
  slack: "purple", discord: "purple", "microsoft teams": "purple", mail: "blue", "microsoft outlook": "blue", outlook: "blue",
  telegram: "blue", signal: "blue", messages: "green", whatsapp: "green",
};
const newComputer = (): { config: ComputerConfig; state: ComputerState } =>
  ({ config: { clock: true, cards: false, off: false }, state: { at: 0, app: "", os: "", error: null } });
const MUSIC_RANK: Record<string, number> = { spotify: 3, computer: 2, lastfm: 1 };
export const COMPUTER_STALE_SECS = 150;
interface Status { ok: boolean; error: string | null; at: number }
interface Playing { title: string; artist: string; src: string; at: number }
interface RainState extends Status { alertedUntil: number }
interface EmailConfig { host: string; user: string; pass: string; subjects: boolean }
interface EmailState extends Status { uidNext: number; uidValidity: string; unseen: number }
interface SlackConfig { token: string; userId: string; team: string }
interface SlackState extends Status { lastTs: string }
interface GoogleConfig { refresh: string; access: string; exp: number; email: string }
interface GoogleState extends Status { count: number; calendars: number }
const GOOGLE_CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
interface ReminderRow { id: number; user_id: number; label: string; kind: string; every_min: number | null; start_min: number | null;
  end_min: number | null; at_min: number | null; days: number; last_fired: number }
export const REMINDER_EVERY = [15, 30, 45, 60, 90, 120, 180, 240];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localParts(t: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: isValidTz(tz) ? tz : "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(t * 1000));
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { min: Number(g("hour")) * 60 + Number(g("minute")), wday: WEEKDAYS.indexOf(g("weekday")) };
}

export function slackText(t: string): string {
  return oneLine(String(t ?? "")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1").replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1").replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

async function callJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); } catch { throw new FetchError("unreachable"); }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body };
}

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

type StocksState = Record<string, { price?: number; pct?: number; aboveSide?: string; belowSide?: string; movedDay?: string; error?: string | null; at?: number }>;

const errCode = (e: unknown) => (e instanceof FetchError ? e.code : e instanceof HttpError ? e.code : "failed");

function tzOffsetMs(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}

function wallToInstant(floating: Date, tz: string | undefined): number {
  if (!tz || !isValidTz(tz) || /^(utc|etc\/utc|gmt|z)$/i.test(tz)) return floating.getTime();
  const guess = floating.getTime();
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}

export function eventsFromIcs(text: string, from: number, to: number): CalEvent[] {
  const data = ical.sync.parseICS(text);
  const out: CalEvent[] = [];
  const push = (uid: string, startMs: number, endMs: number, ev: any) => {
    const start = Math.floor(startMs / 1000), end = Math.floor(endMs / 1000);
    if (start < from || start > to) return;
    out.push({ key: `${uid}@${start}`, start, end, title: trunc(oneLine(String(ev.summary ?? "Event")), 60) || "Event",
      location: trunc(oneLine(String(ev.location ?? "")), 40) });
  };
  for (const ev of Object.values(data) as any[]) {
    if (!ev || ev.type !== "VEVENT" || !ev.start || ev.datetype === "date") continue;
    if (String(ev.status ?? "").toUpperCase() === "CANCELLED") continue;
    const uid = String(ev.uid ?? ev.summary ?? "event");
    const dur = ev.end ? ev.end.getTime() - ev.start.getTime() : 0;
    if (!ev.rrule) { push(uid, ev.start.getTime(), ev.start.getTime() + dur, ev); continue; }
    const tz: string | undefined = ev.start.tz;
    const occ: Date[] = ev.rrule.between(new Date((from - 86400) * 1000), new Date((to + 86400) * 1000), true);
    for (const o of occ) {
      const day = o.toISOString().slice(0, 10);
      if (ev.exdate && (ev.exdate[day] || ev.exdate[o.toISOString()])) continue;
      const override = ev.recurrences?.[day];
      if (override) {
        if (override.start && override.datetype !== "date") {
          push(uid, override.start.getTime(), override.end ? override.end.getTime() : override.start.getTime() + dur, override);
        }
        continue;
      }
      const s = wallToInstant(o, tz);
      push(uid, s, s + dur, ev);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function maskUrl(u: string): string {
  try {
    const url = normalizeUrl(u);
    const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${url.host}/…/${tail.length > 24 ? tail.slice(0, 10) + "…" + tail.slice(-8) : tail}`;
  } catch { return "calendar"; }
}

function fmtPrice(p: number) { return p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(3); }

export class Apps {
  private inflight = new Set<string>();
  private due = new Map<string, number>();
  private events = new Map<number, CalEvent[]>();
  private quotes = new Map<string, Quote>();
  private nextUsers = new Set<number>();
  private oauth = new Map<string, { userId: number; kind: string; verifier: string; exp: number }>();
  private playing = new Map<number, Playing>();
  private pcEvents = new Map<number, { at: number; events: CalEvent[] }>();
  private googleEvents = new Map<number, CalEvent[]>();
  private badgeCardAt = new Map<string, number>();

  constructor(private db: DB, private svc: Service, private cfg: Config, private log: (...a: unknown[]) => void = () => {}) {}

  private now() { return Math.floor(this.cfg.now()); }

  private get<C, S>(userId: number, kind: string): { config: C; state: S } | null {
    const r = this.db.prepare("SELECT config, state FROM apps WHERE user_id = ? AND kind = ?").get(userId, kind) as
      { config: string; state: string | null } | undefined;
    if (!r) return null;
    try { return { config: JSON.parse(r.config) as C, state: (r.state ? JSON.parse(r.state) : {}) as S }; } catch { return null; }
  }

  private put(userId: number, kind: string, config: unknown, state: unknown) {
    this.db.prepare(`INSERT INTO apps (user_id, kind, config, state, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET config = excluded.config, state = excluded.state, updated = excluded.updated`)
      .run(userId, kind, JSON.stringify(config), JSON.stringify(state), this.now());
  }

  private putState(userId: number, kind: string, state: unknown) {
    this.db.prepare("UPDATE apps SET state = ? WHERE user_id = ? AND kind = ?").run(JSON.stringify(state), userId, kind);
  }

  private remove(userId: number, kind: string) {
    this.db.prepare("DELETE FROM apps WHERE user_id = ? AND kind = ?").run(userId, kind);
    this.due.delete(`${kind}:${userId}`);
  }

  private tz(userId: number) { return this.svc.userById(userId)?.tz ?? "UTC"; }

  view(userId: number, hubUrl: string) {
    const u = this.svc.userById(userId)!;
    const cal = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    const gh = this.get<GithubConfig, GithubState>(userId, "github");
    const st = this.get<StocksConfig, StocksState>(userId, "stocks");
    const now = this.now();
    return {
      webhook: { url: `${hubUrl}/api/notify/${u.hook_token}` },
      timers: this.listTimers(userId),
      calendar: {
        feeds: (cal?.config.feeds ?? []).map((f, i) => ({ label: maskUrl(f), ...(cal?.state.feeds?.[i] ?? { ok: null, error: null, at: null, count: 0 }) })),
        remind: cal?.config.remind ?? 10,
        showNext: cal?.config.showNext ?? true,
        upcoming: this.calEvents(userId).filter((e) => e.start > now).slice(0, 3).map((e) => ({ title: e.title, start: e.start })),
        fromComputer: (this.pcEvents.get(userId)?.events ?? []).filter((e) => e.start > now).length,
        google: this.googleView(userId),
      },
      github: gh
        ? { connected: true, login: gh.config.login, reasons: gh.config.reasons, ok: gh.state.ok ?? null, error: gh.state.error ?? null, at: gh.state.at ?? null }
        : { connected: false, login: null, reasons: Object.fromEntries(GITHUB_REASONS.map((r) => [r, r !== "comment"])), ok: null, error: null, at: null },
      stocks: {
        items: st?.config.items ?? [],
        quotes: Object.fromEntries(Object.entries(st?.state ?? {}).map(([k, s]) => [k, { price: s.price ?? null, pct: s.pct ?? null, error: s.error ?? null, at: s.at ?? null }])),
      },
      ...this.moreView(userId),
    };
  }

  private moreView(userId: number) {
    const sp = this.get<SpotifyConfig, Status>(userId, "spotify");
    const lf = this.get<LastfmConfig, Status>(userId, "lastfm");
    const rain = this.get<{ on: boolean }, RainState>(userId, "rain");
    const em = this.get<EmailConfig, EmailState>(userId, "email");
    const sl = this.get<SlackConfig, SlackState>(userId, "slack");
    const st = (x: { state: Status } | null) => (x ? { ok: x.state.ok ?? null, error: x.state.error ?? null, at: x.state.at ?? null } : {});
    const p = this.playing.get(userId);
    const pc = this.get<ComputerConfig, ComputerState>(userId, "computer");
    return {
      computer: this.computerView(userId),
      music: {
        playing: p ? { title: p.title, artist: p.artist, src: p.src } : null,
        computer: { on: !pc?.config.off, seen: pc?.state.at || null, app: pc?.state.app ?? "", os: pc?.state.os ?? "", error: pc?.state.error ?? null,
          clock: pc?.config.clock ?? true, cards: pc?.config.cards ?? false },
        spotify: { configured: !!this.cfg.spotifyClientId, connected: !!sp, name: sp?.config.name ?? null, clock: sp?.config.clock ?? true, cards: sp?.config.cards ?? false, ...st(sp) },
        lastfm: { configured: !!this.cfg.lastfmKey, signin: !!(this.cfg.lastfmKey && this.cfg.lastfmSecret), connected: !!lf, user: lf?.config.user ?? null, clock: lf?.config.clock ?? true, cards: lf?.config.cards ?? false, ...st(lf) },
      },
      reminders: this.listReminders(userId),
      rain: { on: !!rain, hasLocation: !!this.location(userId), ...st(rain) },
      email: em ? { connected: true, host: em.config.host, user: em.config.user, subjects: em.config.subjects, unseen: em.state.unseen ?? null, ...st(em) } : { connected: false },
      slack: { configured: !!(this.cfg.slackClientId && this.cfg.slackClientSecret), connected: !!sl, team: sl?.config.team ?? null, ...st(sl) },
    };
  }

  private hasOnlineDesk(userId: number) { return this.svc.devicesOf(userId).some((d) => this.svc.broker?.isOnline(d.chip)); }

  disconnect(userId: number, kind: string) {
    if (!["spotify", "lastfm", "rain", "email", "slack", "google"].includes(kind)) throw new HttpError(404, "not_found");
    if (kind === "google") {
      const g = this.get<GoogleConfig, GoogleState>(userId, "google");
      if (g) callJson(`${this.cfg.googleOAuth}/revoke`, form({ token: g.config.refresh })).catch(() => {});
      this.googleEvents.delete(userId);
    }
    this.remove(userId, kind);
    if ((kind === "spotify" || kind === "lastfm") && this.playing.get(userId)?.src === kind) this.playing.delete(userId);
    this.updateNext(userId);
  }

  private googleView(userId: number) {
    const g = this.get<GoogleConfig, GoogleState>(userId, "google");
    return {
      configured: !!(this.cfg.googleClientId && this.cfg.googleClientSecret), connected: !!g, email: g?.config.email ?? null,
      ok: g?.state.ok ?? null, error: g?.state.error ?? null, at: g?.state.at ?? null,
      upcoming: (this.googleEvents.get(userId) ?? []).filter((e) => e.start > this.now()).length,
    };
  }

  oauthStart(userId: number, kind: "spotify" | "slack" | "lastfm" | "google", redirectUri: string): string {
    const now = this.now();
    for (const [k, v] of this.oauth) if (v.exp < now) this.oauth.delete(k);
    if (kind === "spotify" && !this.cfg.spotifyClientId) throw new HttpError(409, "spotify_not_configured");
    if (kind === "slack" && !(this.cfg.slackClientId && this.cfg.slackClientSecret)) throw new HttpError(409, "slack_not_configured");
    if (kind === "lastfm" && !(this.cfg.lastfmKey && this.cfg.lastfmSecret)) throw new HttpError(409, "lastfm_not_configured");
    if (kind === "google" && !(this.cfg.googleClientId && this.cfg.googleClientSecret)) throw new HttpError(409, "google_not_configured");
    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(48).toString("base64url");
    this.oauth.set(state, { userId, kind, verifier, exp: now + 600 });
    if (kind === "spotify") {
      return `${this.cfg.spotifyAccounts}/authorize?` + new URLSearchParams({
        response_type: "code", client_id: this.cfg.spotifyClientId!, scope: "user-read-currently-playing user-read-playback-state",
        redirect_uri: redirectUri, code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), state,
      });
    }
    if (kind === "google") {
      return `${this.cfg.googleAccounts}/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: this.cfg.googleClientId!, redirect_uri: redirectUri, response_type: "code", scope: `openid email ${GOOGLE_CAL_SCOPE}`,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
        code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      });
    }
    if (kind === "lastfm") return this.cfg.lastfmAuth + "?" + new URLSearchParams({ api_key: this.cfg.lastfmKey!, cb: `${redirectUri}/${state}` });
    return "https://slack.com/oauth/v2/authorize?" + new URLSearchParams({ client_id: this.cfg.slackClientId!, user_scope: "search:read", redirect_uri: redirectUri, state });
  }

  private takeState(userId: number, kind: string, state: string) {
    const o = this.oauth.get(state);
    this.oauth.delete(state);
    if (!o || o.userId !== userId || o.kind !== kind || o.exp < this.now()) throw new HttpError(400, "oauth_state");
    return o;
  }

  async spotifyCallback(userId: number, code: string, state: string, redirectUri: string) {
    const o = this.takeState(userId, "spotify", state);
    const tok = await callJson(`${this.cfg.spotifyAccounts}/api/token`, form({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: this.cfg.spotifyClientId!, code_verifier: o.verifier,
    }));
    if (tok.status !== 200 || !tok.body?.access_token || !tok.body?.refresh_token) throw new HttpError(400, "spotify_denied");
    const me = await callJson(`${this.cfg.spotifyApi}/v1/me`, { headers: { Authorization: `Bearer ${tok.body.access_token}` } }).catch(() => ({ status: 0, body: null }));
    if (me.status === 403) throw new HttpError(403, "spotify_invite_only");
    const prev = this.get<SpotifyConfig, Status>(userId, "spotify");
    const now = this.now();
    this.put(userId, "spotify", {
      refresh: tok.body.refresh_token, access: tok.body.access_token, exp: now + (Number(tok.body.expires_in) || 3600),
      name: String(me.body?.display_name || me.body?.id || "Spotify"), clock: prev?.config.clock ?? true, cards: prev?.config.cards ?? false,
    }, { ok: true, error: null, at: now });
    this.due.set(`spotify:${userId}`, now);
  }

  async connectLastfm(userId: number, raw: unknown) {
    if (!this.cfg.lastfmKey) throw new HttpError(409, "lastfm_not_configured");
    const user = typeof raw === "string" ? raw.trim() : "";
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(user)) throw new HttpError(400, "lastfm_user");
    const r = await callJson(`${this.cfg.lastfmApi}/2.0/?` + new URLSearchParams({ method: "user.getinfo", user, api_key: this.cfg.lastfmKey, format: "json" }))
      .catch(() => { throw new HttpError(400, "lastfm_unreachable"); });
    if (r.status !== 200 || r.body?.error || !r.body?.user) throw new HttpError(400, "lastfm_user");
    this.saveLastfm(userId, String(r.body.user.name || user));
  }

  async lastfmCallback(userId: number, token: string, state: string) {
    this.takeState(userId, "lastfm", state);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw new HttpError(400, "lastfm_denied");
    const key = this.cfg.lastfmKey ?? "";
    const sig = crypto.createHash("md5").update(`api_key${key}methodauth.getSessiontoken${token}${this.cfg.lastfmSecret ?? ""}`).digest("hex");
    const r = await callJson(`${this.cfg.lastfmApi}/2.0/?` + new URLSearchParams({ method: "auth.getSession", api_key: key, token, api_sig: sig, format: "json" }))
      .catch(() => { throw new HttpError(400, "lastfm_unreachable"); });
    const name = r.body?.session?.name;
    if (r.status !== 200 || !name || !/^[A-Za-z0-9_.-]{2,40}$/.test(String(name))) throw new HttpError(400, "lastfm_denied");
    this.saveLastfm(userId, String(name));
  }

  private saveLastfm(userId: number, user: string) {
    const prev = this.get<LastfmConfig, Status>(userId, "lastfm");
    this.put(userId, "lastfm", { user, clock: prev?.config.clock ?? true, cards: prev?.config.cards ?? false }, { ok: true, error: null, at: this.now() });
    this.due.set(`lastfm:${userId}`, this.now());
  }

  setMusicOptions(userId: number, kind: unknown, b: { clock?: unknown; cards?: unknown; on?: unknown }) {
    if (kind !== "spotify" && kind !== "lastfm" && kind !== "computer") throw new HttpError(404, "not_found");
    const cur = this.get<MusicConfig & { off?: boolean }, unknown>(userId, kind)
      ?? (kind === "computer" ? { config: { clock: true, cards: false, off: false }, state: { at: 0, app: "", os: "", error: null } } : null);
    if (!cur) throw new HttpError(404, "not_found");
    if (b.clock !== undefined) cur.config.clock = !!b.clock;
    if (b.cards !== undefined) cur.config.cards = !!b.cards;
    if (kind === "computer" && b.on !== undefined) cur.config.off = !b.on;
    this.put(userId, kind, cur.config, cur.state);
    if (cur.config.off) this.setPlaying(userId, "computer", null);
    this.updateNext(userId);
  }

  computerView(userId: number) {
    const pc = this.get<ComputerConfig, ComputerState>(userId, "computer") ?? newComputer();
    const muted = new Set(pc.config.muted ?? DEFAULT_MUTED);
    const badges = pc.state.badges ?? {};
    return {
      seen: pc.state.at || null, os: pc.state.os, music: !pc.config.off, calendar: pc.config.calendar !== false,
      presence: pc.config.presence !== false, away: !!pc.state.away, cal: pc.state.cal ?? null, dock: pc.state.dock ?? null,
      apps: [...new Set([...(pc.state.at ? COMMON_BADGE_APPS : []), ...(pc.state.known ?? [])])].map((app) => ({ app, count: badges[app] ?? 0, muted: muted.has(app) })),
    };
  }

  setComputerOptions(userId: number, b: Record<string, unknown>) {
    const cur = this.get<ComputerConfig, ComputerState>(userId, "computer") ?? newComputer();
    if (b.music !== undefined) cur.config.off = !b.music;
    if (b.calendar !== undefined) cur.config.calendar = !!b.calendar;
    if (b.presence !== undefined) cur.config.presence = !!b.presence;
    if (b.mute && typeof b.mute === "object" && !Array.isArray(b.mute)) {
      const m = new Set(cur.config.muted ?? DEFAULT_MUTED);
      for (const [k, v] of Object.entries(b.mute as Record<string, unknown>).slice(0, 30)) {
        const name = trunc(oneLine(k), 30);
        if (v) m.add(name); else m.delete(name);
      }
      cur.config.muted = [...m].slice(0, 60);
    }
    this.put(userId, "computer", cur.config, cur.state);
    if (cur.config.off) this.setPlaying(userId, "computer", null);
    this.updateNext(userId);
    return this.computerView(userId);
  }

  presence(userId: number): { away: boolean; since: number } | null {
    const pc = this.get<ComputerConfig, ComputerState>(userId, "computer");
    if (!pc || pc.config.presence === false || !pc.state.at) return null;
    const now = this.now();
    if (now - pc.state.at > 7 * 86400) return null;
    if (now - pc.state.at > PRESENCE_STALE_SECS) return { away: true, since: pc.state.at };
    if (pc.state.away) return { away: true, since: pc.state.awaySince || pc.state.at };
    return { away: false, since: 0 };
  }

  reportComputer(userId: number, b: Record<string, unknown>) {
    const now = this.now();
    const cur = this.get<ComputerConfig, ComputerState>(userId, "computer");
    const config = cur?.config ?? newComputer().config;
    const prev = cur?.state;
    const text = (v: unknown, n: number) => trunc(oneLine(typeof v === "string" ? v : ""), n);
    const state: ComputerState = {
      at: now, app: text(b.app, 30), os: ["mac", "windows", "linux"].includes(String(b.os)) ? String(b.os) : "",
      error: typeof b.error === "string" && /^[a-z_]{1,30}$/.test(b.error) ? b.error : null,
      badges: prev?.badges ?? {}, known: prev?.known ?? [], away: prev?.away ?? false, awaySince: prev?.awaySince ?? 0, cal: prev?.cal ?? null,
    };
    if (b.badges && typeof b.badges === "object" && !Array.isArray(b.badges)) {
      state.badges = this.takeBadges(userId, config, prev?.badges ?? {}, b.badges as Record<string, unknown>, !!prev?.at);
      state.known = [...new Set([...(state.known ?? []), ...Object.keys(state.badges)])].slice(-30);
    }
    if (typeof b.away === "boolean") {
      if (b.away && !prev?.away) state.awaySince = now - Math.max(0, Math.min(86400, Math.round(Number(b.idle) || 0)));
      state.away = b.away;
    }
    if (typeof b.calendar === "string" && /^[a-z_]{1,20}$/.test(b.calendar)) state.cal = b.calendar;
    state.dock = typeof b.dock === "string" && /^[a-z_]{1,20}$/.test(b.dock) ? b.dock : null;
    this.put(userId, "computer", config, state);
    if (Array.isArray(b.events)) this.takeEvents(userId, b.events);
    if (!config.off) {
      const title = text(b.title, 200), artist = text(b.artist, 200);
      this.setPlaying(userId, "computer", b.playing === true && title ? { title, artist } : null);
    }
    return { ok: true, off: !!config.off };
  }

  private takeBadges(userId: number, config: ComputerConfig, prev: Record<string, number>, raw: Record<string, unknown>, known: boolean) {
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw).slice(0, 30)) {
      const name = trunc(oneLine(k.replace(/[\u200e\u200f\u202a-\u202e]/g, "")), 30);
      const n = Math.round(Number(v));
      if (!name || !Number.isFinite(n) || n === 0 || n < -1 || n > 100000) continue;
      next[name] = n;
    }
    if (!known) return next;
    const muted = new Set(config.muted ?? DEFAULT_MUTED);
    const now = this.now();
    for (const [name, n] of Object.entries(next)) {
      const before = prev[name] ?? 0;
      if (muted.has(name) || !(n === -1 ? before === 0 : n > Math.max(0, before))) continue;
      const key = `${userId}:${name}`;
      if (now - (this.badgeCardAt.get(key) ?? 0) < 60) continue;
      this.badgeCardAt.set(key, now);
      this.svc.sendCard(userId, { src: name, title: n === -1 ? "Something new" : `${n} unread`, color: BADGE_COLOR[name.toLowerCase()] ?? "teal", secs: 20 });
    }
    return next;
  }

  private takeEvents(userId: number, raw: unknown[]) {
    const now = this.now();
    const events: CalEvent[] = [];
    for (const x of raw.slice(0, 60)) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const start = Math.round(Number(o.s)), end = Math.round(Number(o.e));
      const title = trunc(oneLine(typeof o.t === "string" ? o.t : ""), 100);
      if (!title || !Number.isFinite(start) || start < now - 86400 || start > now + 3 * 86400) continue;
      events.push({ key: `pc:${start}:${title}`, start, end: Number.isFinite(end) && end >= start ? end : start, title,
        location: trunc(oneLine(typeof o.l === "string" ? o.l : ""), 60) });
    }
    this.pcEvents.set(userId, { at: now, events: events.sort((a, b) => a.start - b.start) });
    if (events.length && !this.get(userId, "calendar")) this.put(userId, "calendar", { feeds: [], remind: 10, showNext: true }, { feeds: [], reminded: [] });
    this.updateNext(userId);
  }

  private calEvents(userId: number): CalEvent[] {
    const pc = this.get<ComputerConfig, ComputerState>(userId, "computer");
    const fromPc = pc?.config.calendar !== false ? this.pcEvents.get(userId)?.events ?? [] : [];
    const seen = new Set<string>();
    return [...(this.events.get(userId) ?? []), ...(this.googleEvents.get(userId) ?? []), ...fromPc].sort((a, b) => a.start - b.start)
      .filter((e) => { const k = `${e.title}|${e.start}`; return !seen.has(k) && !!seen.add(k); });
  }

  private setPlaying(userId: number, src: string, p: { title: string; artist: string } | null) {
    const cur = this.playing.get(userId);
    if (!p) { if (cur?.src === src) { this.playing.delete(userId); this.updateNext(userId); } return; }
    if (cur && cur.src !== src && (MUSIC_RANK[cur.src] ?? 0) > (MUSIC_RANK[src] ?? 0) && this.now() - cur.at < 90) return;
    const changed = !cur || cur.title !== p.title || cur.artist !== p.artist;
    this.playing.set(userId, { title: trunc(oneLine(p.title), 60), artist: trunc(oneLine(p.artist), 60), src, at: this.now() });
    if (changed) {
      if (this.get<MusicConfig, Status>(userId, src)?.config.cards) {
        this.svc.sendCard(userId, { src: "Now playing", title: p.title, text: p.artist, color: "green", secs: 8 });
      }
      this.updateNext(userId);
    }
  }

  private async pollSpotify(userId: number) {
    const cur = this.get<SpotifyConfig, Status>(userId, "spotify");
    if (!cur) return;
    const c = cur.config, s = cur.state;
    let wait = 30;
    try {
      if (c.exp - 60 < this.now()) {
        const r = await callJson(`${this.cfg.spotifyAccounts}/api/token`, form({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: this.cfg.spotifyClientId ?? "" }));
        if (r.status !== 200 || !r.body?.access_token) {
          Object.assign(s, { ok: false, error: r.status === 400 ? "reconnect" : `http_${r.status}`, at: this.now() });
          this.setPlaying(userId, "spotify", null);
          this.put(userId, "spotify", c, s);
          this.due.set(`spotify:${userId}`, this.now() + 300);
          return;
        }
        c.access = r.body.access_token;
        c.exp = this.now() + (Number(r.body.expires_in) || 3600);
        if (r.body.refresh_token) c.refresh = r.body.refresh_token;
      }
      const r = await callJson(`${this.cfg.spotifyApi}/v1/me/player/currently-playing?additional_types=episode`, { headers: { Authorization: `Bearer ${c.access}` } });
      if (r.status === 401) { c.exp = 0; wait = 5; }
      else if (r.status === 429) wait = 120;
      else if (r.status === 204 || r.status === 200) {
        const it = r.body?.item;
        if (r.status === 200 && r.body?.is_playing && it) {
          this.setPlaying(userId, "spotify", { title: String(it.name ?? ""), artist: (it.artists ?? []).map((a: any) => a.name).join(", ") || String(it.show?.name ?? "") });
          wait = 15;
        } else this.setPlaying(userId, "spotify", null);
        Object.assign(s, { ok: true, error: null });
      } else Object.assign(s, { ok: false, error: `http_${r.status}` });
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    this.put(userId, "spotify", c, s);
    this.due.set(`spotify:${userId}`, this.now() + wait);
  }

  private async pollLastfm(userId: number) {
    const cur = this.get<LastfmConfig, Status>(userId, "lastfm");
    if (!cur || !this.cfg.lastfmKey) return;
    const s = cur.state;
    try {
      const r = await callJson(`${this.cfg.lastfmApi}/2.0/?` + new URLSearchParams({ method: "user.getrecenttracks", user: cur.config.user, api_key: this.cfg.lastfmKey, format: "json", limit: "1" }));
      if (r.status !== 200 || r.body?.error) Object.assign(s, { ok: false, error: r.body?.error === 6 ? "lastfm_user" : `http_${r.status}` });
      else {
        const tr = r.body?.recenttracks?.track;
        const t = Array.isArray(tr) ? tr[0] : tr;
        if (t && t["@attr"]?.nowplaying === "true") this.setPlaying(userId, "lastfm", { title: String(t.name ?? ""), artist: String(t.artist?.["#text"] ?? t.artist?.name ?? "") });
        else this.setPlaying(userId, "lastfm", null);
        Object.assign(s, { ok: true, error: null });
      }
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    this.putState(userId, "lastfm", s);
    this.due.set(`lastfm:${userId}`, this.now() + 30);
  }

  listReminders(userId: number) {
    return (this.db.prepare("SELECT * FROM reminders WHERE user_id = ? ORDER BY id").all(userId) as ReminderRow[]).map((r) => ({
      id: r.id, label: r.label, kind: r.kind, every: r.every_min, start: r.start_min, end: r.end_min, at: r.at_min, days: r.days,
    }));
  }

  addReminder(userId: number, b: Record<string, unknown>) {
    const label = trunc(oneLine(typeof b.label === "string" ? b.label : ""), 24);
    if (!label) throw new HttpError(400, "label");
    const days = Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > 127) throw new HttpError(400, "days");
    const minOk = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < 1440;
    if (this.listReminders(userId).length >= 20) throw new HttpError(400, "too_many");
    const now = this.now();
    if (b.kind === "at") {
      if (!minOk(b.at)) throw new HttpError(400, "time");
      this.db.prepare("INSERT INTO reminders (user_id, label, kind, at_min, days, created) VALUES (?, ?, 'at', ?, ?, ?)").run(userId, label, Number(b.at), days, now);
    } else if (b.kind === "every") {
      const every = Number(b.every);
      if (!REMINDER_EVERY.includes(every)) throw new HttpError(400, "every");
      if (!minOk(b.start) || !minOk(b.end) || Number(b.start) >= Number(b.end)) throw new HttpError(400, "time");
      this.db.prepare("INSERT INTO reminders (user_id, label, kind, every_min, start_min, end_min, days, created) VALUES (?, ?, 'every', ?, ?, ?, ?, ?)")
        .run(userId, label, every, Number(b.start), Number(b.end), days, now);
    } else throw new HttpError(400, "kind");
    return this.listReminders(userId);
  }

  removeReminder(userId: number, id: number) {
    if (!this.db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(id, userId).changes) throw new HttpError(404, "not_found");
  }

  private fireReminders(now: number) {
    for (const r of this.db.prepare("SELECT * FROM reminders WHERE last_fired < ?").all(now - 90) as ReminderRow[]) {
      const tz = this.tz(r.user_id);
      const { min, wday } = localParts(now, tz);
      if (wday < 0 || !(r.days & (1 << wday))) continue;
      const hit = r.kind === "at" ? min === r.at_min
        : r.start_min !== null && r.end_min !== null && r.every_min && min >= r.start_min && min <= r.end_min && (min - r.start_min) % r.every_min === 0;
      if (!hit) continue;
      this.db.prepare("UPDATE reminders SET last_fired = ? WHERE id = ?").run(now, r.id);
      this.svc.sendCard(r.user_id, { src: "Reminder", title: r.label, text: hhmm(now, tz), color: "yellow", secs: 60 });
    }
  }

  private location(userId: number): { lat: number; lon: number } | null {
    for (const d of this.svc.devicesOf(userId)) {
      for (const raw of [d.reported, d.settings]) {
        try {
          const j = raw ? JSON.parse(raw) : null;
          const lat = Number(j?.lat), lon = Number(j?.lon);
          if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) return { lat, lon };
        } catch { continue; }
      }
    }
    return null;
  }

  setRain(userId: number, on: unknown) {
    if (!on) { this.remove(userId, "rain"); return; }
    if (!this.location(userId)) throw new HttpError(400, "no_location");
    this.put(userId, "rain", { on: true }, { ok: true, error: null, at: this.now(), alertedUntil: 0 });
    this.due.set(`rain:${userId}`, this.now());
  }

  private async pollRain(userId: number) {
    const cur = this.get<{ on: boolean }, RainState>(userId, "rain");
    const loc = this.location(userId);
    if (!cur) return;
    const s = cur.state;
    try {
      if (!loc) throw new FetchError("no_location");
      const r = await callJson(`${this.cfg.weatherApi}/v1/forecast?` + new URLSearchParams({
        latitude: loc.lat.toFixed(3), longitude: loc.lon.toFixed(3), minutely_15: "precipitation", forecast_minutely_15: "8", timezone: "GMT",
      }));
      const m = r.body?.minutely_15;
      if (r.status !== 200 || !Array.isArray(m?.time) || !Array.isArray(m?.precipitation)) throw new FetchError(`http_${r.status}`);
      const now = this.now();
      const slots = (m.time as string[]).map((t, i) => ({ t: Math.floor(Date.parse(t.endsWith("Z") ? t : t + "Z") / 1000), p: Number(m.precipitation[i]) || 0 }));
      const i0 = Math.max(0, slots.findIndex((x) => x.t + 900 > now));
      const raining = slots[i0]?.p >= 0.1;
      const soon = slots.slice(i0 + 1, i0 + 3).find((x) => x.p >= 0.2);
      if (raining) s.alertedUntil = Math.max(s.alertedUntil ?? 0, now + 3600);
      else if (soon && (s.alertedUntil ?? 0) < now) {
        const total = slots.slice(i0 + 1, i0 + 5).reduce((a, x) => a + x.p, 0);
        this.svc.sendCard(userId, { src: "Weather", title: "Rain soon", color: "blue", secs: 60,
          text: `in about ${Math.max(5, Math.round((soon.t - now) / 60 / 5) * 5)} min · ${total.toFixed(1)} mm in the next hour` });
        s.alertedUntil = now + 3 * 3600;
      }
      Object.assign(s, { ok: true, error: null });
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    this.putState(userId, "rain", s);
    this.due.set(`rain:${userId}`, this.now() + 15 * 60);
  }

  private async imapHost(host: string) {
    if (!/^[a-z0-9.-]{3,100}$/i.test(host) || !host.includes(".")) throw new HttpError(400, "email_host");
    if (this.cfg.allowPrivateFetch) return;
    let addrs: dns.LookupAddress[];
    try { addrs = await dns.promises.lookup(host, { all: true }); } catch { throw new HttpError(400, "email_host"); }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "email_host");
  }

  private async imapStatus(c: { host: string; user: string; pass: string }, since: number | null) {
    const client = new ImapFlow({ host: c.host, port: 993, secure: true, auth: { user: c.user, pass: c.pass }, logger: false,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    client.on("error", () => {});
    try { await client.connect(); } catch (e: any) { throw new HttpError(400, e?.authenticationFailed ? "email_login" : "email_unreachable"); }
    try {
      const st = await client.status("INBOX", { uidNext: true, unseen: true, uidValidity: true });
      const fresh: { from: string; subject: string }[] = [];
      if (since !== null && st.uidNext && st.uidNext > since) {
        const lock = await client.getMailboxLock("INBOX");
        try {
          for await (const m of client.fetch(`${since}:${st.uidNext - 1}`, { envelope: true, flags: true }, { uid: true })) {
            if (m.flags?.has("\\Seen")) continue;
            const f = m.envelope?.from?.[0];
            fresh.push({ from: String(f?.name || f?.address || "Someone"), subject: String(m.envelope?.subject || "") });
          }
        } finally { lock.release(); }
      }
      return { uidNext: st.uidNext ?? 0, uidValidity: String(st.uidValidity ?? ""), unseen: st.unseen ?? 0, fresh };
    } finally { await client.logout().catch(() => {}); }
  }

  async connectEmail(userId: number, b: Record<string, unknown>) {
    const host = String(b.host ?? "").trim().toLowerCase(), user = String(b.user ?? "").trim(), pass = String(b.pass ?? "");
    if (!user || user.length > 200 || !pass || pass.length > 200) throw new HttpError(400, "email_login");
    await this.imapHost(host);
    const st = await this.imapStatus({ host, user, pass }, null);
    this.put(userId, "email", { host, user, pass, subjects: b.subjects !== false }, { uidNext: st.uidNext, uidValidity: st.uidValidity, unseen: st.unseen, ok: true, error: null, at: this.now() });
    this.due.set(`email:${userId}`, this.now() + 180);
  }

  setEmailOptions(userId: number, b: { subjects?: unknown }) {
    const cur = this.get<EmailConfig, EmailState>(userId, "email");
    if (!cur) throw new HttpError(404, "not_found");
    if (b.subjects !== undefined) cur.config.subjects = !!b.subjects;
    this.put(userId, "email", cur.config, cur.state);
  }

  private async pollEmail(userId: number) {
    const cur = this.get<EmailConfig, EmailState>(userId, "email");
    if (!cur) return;
    const s = cur.state;
    try {
      const st = await this.imapStatus(cur.config, s.uidValidity && s.uidNext ? s.uidNext : null);
      if (st.uidValidity !== s.uidValidity) st.fresh = [];
      const list = st.fresh.slice(-3).reverse();
      for (const m of list) this.svc.sendCard(userId, { src: "Email", title: m.from, text: cur.config.subjects ? m.subject || "(no subject)" : "New email", color: "orange", secs: 30 });
      if (st.fresh.length > 3) this.svc.sendCard(userId, { src: "Email", title: `${st.fresh.length - 3} more`, text: "new emails", color: "orange" });
      Object.assign(s, { uidNext: st.uidNext, uidValidity: st.uidValidity, unseen: st.unseen, ok: true, error: null });
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    this.putState(userId, "email", s);
    this.due.set(`email:${userId}`, this.now() + 180);
  }

  async googleCallback(userId: number, code: string, state: string, redirectUri: string) {
    const o = this.takeState(userId, "google", state);
    const tok = await callJson(`${this.cfg.googleOAuth}/token`, form({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: o.verifier,
      client_id: this.cfg.googleClientId ?? "", client_secret: this.cfg.googleClientSecret ?? "",
    }));
    const t = tok.body;
    if (tok.status !== 200 || !t?.access_token || !t?.refresh_token) throw new HttpError(400, "google_denied");
    if (!String(t.scope ?? "").split(" ").includes(GOOGLE_CAL_SCOPE)) throw new HttpError(400, "google_scope");
    let email = "";
    try { email = String(JSON.parse(Buffer.from(String(t.id_token).split(".")[1], "base64url").toString("utf8")).email ?? ""); } catch { email = ""; }
    const now = this.now();
    this.put(userId, "google", { refresh: t.refresh_token, access: t.access_token, exp: now + (Number(t.expires_in) || 3600), email: trunc(email, 80) },
      { ok: true, error: null, at: now, count: 0, calendars: 0 });
    if (!this.get(userId, "calendar")) this.put(userId, "calendar", { feeds: [], remind: 10, showNext: true }, { feeds: [], reminded: [] });
    await this.run(`google:${userId}`, () => this.pollGoogle(userId));
  }

  private async googleToken(userId: number, c: GoogleConfig, s: GoogleState): Promise<string | null> {
    if (c.exp - 60 > this.now()) return c.access;
    const r = await callJson(`${this.cfg.googleOAuth}/token`, form({
      grant_type: "refresh_token", refresh_token: c.refresh, client_id: this.cfg.googleClientId ?? "", client_secret: this.cfg.googleClientSecret ?? "",
    }));
    if (r.status !== 200 || !r.body?.access_token) {
      Object.assign(s, { ok: false, error: r.body?.error === "invalid_grant" ? "reconnect" : `http_${r.status}`, at: this.now() });
      return null;
    }
    c.access = r.body.access_token;
    c.exp = this.now() + (Number(r.body.expires_in) || 3600);
    return c.access;
  }

  private async pollGoogle(userId: number) {
    const cur = this.get<GoogleConfig, GoogleState>(userId, "google");
    if (!cur) return;
    const c = cur.config, s = cur.state;
    try {
      const token = await this.googleToken(userId, c, s);
      if (token) {
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        const list = await callJson(`${this.cfg.googleApi}/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,selected,hidden)`, auth);
        if (list.status === 401) { c.exp = 0; throw new FetchError("reconnect"); }
        if (list.status !== 200) throw new FetchError(`http_${list.status}`);
        const ids = ((list.body?.items ?? []) as any[]).filter((x) => x.selected && !x.hidden && typeof x.id === "string").map((x) => x.id as string).slice(0, 10);
        const now = this.now();
        const range = new URLSearchParams({
          timeMin: new Date((now - 3600) * 1000).toISOString(), timeMax: new Date((now + 36 * 3600) * 1000).toISOString(),
          singleEvents: "true", orderBy: "startTime", maxResults: "50",
          fields: "items(id,status,summary,location,start,end,attendees(self,responseStatus))",
        });
        const events: CalEvent[] = [];
        for (const id of ids) {
          const r = await callJson(`${this.cfg.googleApi}/calendar/v3/calendars/${encodeURIComponent(id)}/events?${range}`, auth);
          if (r.status !== 200) continue;
          for (const e of (r.body?.items ?? []) as any[]) {
            if (e.status === "cancelled" || !e.start?.dateTime) continue;
            if ((e.attendees ?? []).some((a: any) => a.self && a.responseStatus === "declined")) continue;
            const start = Math.floor(Date.parse(e.start.dateTime) / 1000), end = Math.floor(Date.parse(e.end?.dateTime ?? e.start.dateTime) / 1000);
            if (!Number.isFinite(start)) continue;
            events.push({ key: `g:${e.id}:${start}`, start, end: Number.isFinite(end) ? end : start, title: trunc(oneLine(String(e.summary || "Busy")), 100),
              location: trunc(oneLine(String(e.location ?? "")), 60) });
          }
        }
        this.googleEvents.set(userId, events.sort((a, b) => a.start - b.start));
        Object.assign(s, { ok: true, error: null, count: events.length, calendars: ids.length });
      }
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    if (this.get(userId, "google")) this.put(userId, "google", c, s);
    this.due.set(`google:${userId}`, this.now() + CALENDAR_EVERY_SECS);
    this.updateNext(userId);
  }

  async slackCallback(userId: number, code: string, state: string, redirectUri: string) {
    this.takeState(userId, "slack", state);
    const r = await callJson(`${this.cfg.slackApi}/oauth.v2.access`, form({
      client_id: this.cfg.slackClientId ?? "", client_secret: this.cfg.slackClientSecret ?? "", code, redirect_uri: redirectUri,
    }));
    const u = r.body?.authed_user;
    if (!r.body?.ok || !u?.access_token || !u?.id) throw new HttpError(400, "slack_denied");
    this.put(userId, "slack", { token: u.access_token, userId: u.id, team: String(r.body.team?.name ?? "") },
      { lastTs: String(this.now()), ok: true, error: null, at: this.now() });
    this.due.set(`slack:${userId}`, this.now() + 60);
  }

  private async pollSlack(userId: number) {
    const cur = this.get<SlackConfig, SlackState>(userId, "slack");
    if (!cur) return;
    const s = cur.state;
    try {
      const r = await callJson(`${this.cfg.slackApi}/search.messages?` + new URLSearchParams({ query: `<@${cur.config.userId}>`, sort: "timestamp", sort_dir: "desc", count: "10" }),
        { headers: { Authorization: `Bearer ${cur.config.token}` } });
      if (!r.body?.ok) Object.assign(s, { ok: false, error: ["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(r.body?.error) ? "reconnect" : String(r.body?.error ?? `http_${r.status}`) });
      else {
        const fresh = ((r.body.messages?.matches ?? []) as any[]).filter((m) => Number(m.ts) > Number(s.lastTs) && m.user !== cur.config.userId)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
        for (const m of fresh.slice(-3)) {
          this.svc.sendCard(userId, { src: "Slack", title: `${m.username || "Someone"} in #${m.channel?.name || "a channel"}`, text: slackText(m.text), color: "purple", secs: 30 });
        }
        if (fresh.length > 3) this.svc.sendCard(userId, { src: "Slack", title: `${fresh.length - 3} more`, text: "mentions on Slack", color: "purple" });
        if (fresh.length) s.lastTs = fresh[fresh.length - 1].ts;
        Object.assign(s, { ok: true, error: null });
      }
    } catch (e) { Object.assign(s, { ok: false, error: errCode(e) }); }
    s.at = this.now();
    this.putState(userId, "slack", s);
    this.due.set(`slack:${userId}`, this.now() + 60);
  }

  listTimers(userId: number) {
    return this.db.prepare("SELECT id, label, ends FROM timers WHERE user_id = ? AND ends > ? ORDER BY ends")
      .all(userId, this.now()) as { id: number; label: string; ends: number }[];
  }

  addTimer(userId: number, minutes: unknown, label: unknown) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1 || m > 720) throw new HttpError(400, "minutes");
    if (this.listTimers(userId).length >= MAX_TIMERS) throw new HttpError(400, "too_many");
    const l = trunc(oneLine(typeof label === "string" ? label : ""), 20) || "Timer";
    const now = this.now();
    this.db.prepare("INSERT INTO timers (user_id, label, ends, created) VALUES (?, ?, ?, ?)").run(userId, l, now + Math.round(m * 60), now);
    this.updateNext(userId);
    return this.listTimers(userId);
  }

  cancelTimer(userId: number, id: number) {
    const r = this.db.prepare("DELETE FROM timers WHERE id = ? AND user_id = ?").run(id, userId);
    if (!r.changes) throw new HttpError(404, "not_found");
    this.updateNext(userId);
  }

  private fireTimers(now: number) {
    const due = this.db.prepare("SELECT id, user_id, label FROM timers WHERE ends <= ?").all(now) as { id: number; user_id: number; label: string }[];
    for (const t of due) {
      this.db.prepare("DELETE FROM timers WHERE id = ?").run(t.id);
      this.svc.sendCard(t.user_id, { src: "Timer", title: t.label, text: "Time's up", color: "orange", secs: 60 });
      this.updateNext(t.user_id);
    }
  }

  private async fetchFeed(url: string) {
    const res = await safeFetch(url, { allowPrivate: this.cfg.allowPrivateFetch, headers: { "User-Agent": "claude-desk-hub" } });
    if (res.status !== 200) throw new FetchError(`http_${res.status}`);
    if (!/BEGIN:VCALENDAR/i.test(res.body.slice(0, 2000))) throw new FetchError("not_a_calendar");
    const now = this.now();
    return eventsFromIcs(res.body, now - 3600, now + 36 * 3600);
  }

  async addFeed(userId: number, raw: unknown) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || url.length > 2000) throw new HttpError(400, "url");
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    const config: CalendarConfig = cur?.config ?? { feeds: [], remind: 10, showNext: true };
    if (config.feeds.length >= MAX_FEEDS) throw new HttpError(400, "too_many");
    if (config.feeds.includes(url)) throw new HttpError(400, "duplicate");
    try { await this.fetchFeed(url); } catch (e) { throw new HttpError(400, "calendar_" + errCode(e)); }
    config.feeds.push(url);
    this.put(userId, "calendar", config, { feeds: [], reminded: cur?.state.reminded ?? [] });
    await this.refreshCalendar(userId);
  }

  removeFeed(userId: number, index: number) {
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    if (!cur || !(index >= 0 && index < cur.config.feeds.length)) throw new HttpError(404, "not_found");
    cur.config.feeds.splice(index, 1);
    cur.state.feeds?.splice(index, 1);
    if (!cur.config.feeds.length && !this.pcEvents.get(userId)?.events.length && !this.get(userId, "google")) { this.remove(userId, "calendar"); this.events.delete(userId); }
    else if (!cur.config.feeds.length) { this.put(userId, "calendar", cur.config, cur.state); this.events.delete(userId); }
    else { this.put(userId, "calendar", cur.config, cur.state); this.due.delete(`calendar:${userId}`); }
    this.updateNext(userId);
  }

  setCalendarOptions(userId: number, b: { remind?: unknown; showNext?: unknown }) {
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar") ?? { config: { feeds: [], remind: 10, showNext: true }, state: { feeds: [], reminded: [] } };
    if (b.remind !== undefined) {
      const r = Number(b.remind);
      if (![0, 5, 10, 15, 30, 60].includes(r)) throw new HttpError(400, "remind");
      cur.config.remind = r;
    }
    if (b.showNext !== undefined) cur.config.showNext = !!b.showNext;
    this.put(userId, "calendar", cur.config, cur.state);
    this.updateNext(userId);
  }

  private async refreshCalendar(userId: number) {
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    if (!cur) return;
    const all: CalEvent[] = [];
    const feeds: CalendarState["feeds"] = [];
    for (const url of cur.config.feeds) {
      try {
        const evs = await this.fetchFeed(url);
        all.push(...evs);
        feeds.push({ ok: true, error: null, at: this.now(), count: evs.length });
      } catch (e) {
        feeds.push({ ok: false, error: errCode(e), at: this.now(), count: 0 });
      }
    }
    const seen = new Set<string>();
    this.events.set(userId, all.sort((a, b) => a.start - b.start).filter((e) => !seen.has(e.key) && seen.add(e.key)));
    const fresh = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    if (fresh) this.putState(userId, "calendar", { ...fresh.state, feeds });
    this.due.set(`calendar:${userId}`, this.now() + CALENDAR_EVERY_SECS);
  }

  private remindCalendar(userId: number, now: number) {
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    if (!cur || !cur.config.remind) return;
    const reminded = new Set(cur.state.reminded ?? []);
    let changed = false;
    for (const e of this.calEvents(userId)) {
      if (e.start <= now || e.start - cur.config.remind * 60 > now || reminded.has(e.key)) continue;
      const mins = Math.max(1, Math.round((e.start - now) / 60));
      this.svc.sendCard(userId, {
        src: "Calendar", title: e.title, color: "blue", secs: 60,
        text: `in ${mins} min · ${hhmm(e.start, this.tz(userId))}${e.location ? " · " + e.location : ""}`,
      });
      reminded.add(e.key);
      changed = true;
    }
    if (changed) this.putState(userId, "calendar", { ...cur.state, reminded: [...reminded].slice(-200) });
  }

  private ghHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "claude-desk-hub", "X-GitHub-Api-Version": "2022-11-28" };
  }

  async connectGithub(userId: number, raw: unknown) {
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new HttpError(400, "github_token");
    let login = "";
    try {
      const res = await safeFetch(`${this.cfg.githubApi}/user`, { headers: this.ghHeaders(token), allowPrivate: this.cfg.allowPrivateFetch, maxBytes: 200_000 });
      if (res.status !== 200) throw new HttpError(400, "github_token");
      login = String(JSON.parse(res.body).login ?? "");
    } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, "github_unreachable"); }
    const prev = this.get<GithubConfig, GithubState>(userId, "github");
    const reasons = prev?.config.reasons ?? (Object.fromEntries(GITHUB_REASONS.map((r) => [r, r !== "comment"])) as Record<Reason, boolean>);
    this.put(userId, "github", { token, login, reasons }, { since: this.now(), lastModified: null, seen: [], interval: 60, ok: true, error: null, at: this.now() });
    this.due.set(`github:${userId}`, this.now() + 5);
    return login;
  }

  setGithubReasons(userId: number, reasons: unknown) {
    const cur = this.get<GithubConfig, GithubState>(userId, "github");
    if (!cur) throw new HttpError(404, "not_found");
    if (!reasons || typeof reasons !== "object") throw new HttpError(400, "reasons");
    for (const r of GITHUB_REASONS) if (r in (reasons as object)) cur.config.reasons[r] = !!(reasons as any)[r];
    this.put(userId, "github", cur.config, cur.state);
  }

  disconnectGithub(userId: number) { this.remove(userId, "github"); }

  private async pollGithub(userId: number) {
    const cur = this.get<GithubConfig, GithubState>(userId, "github");
    if (!cur) return;
    const s = cur.state;
    const headers = this.ghHeaders(cur.config.token);
    if (s.lastModified) headers["If-Modified-Since"] = s.lastModified;
    try {
      const res = await safeFetch(`${this.cfg.githubApi}/notifications`, { headers, allowPrivate: this.cfg.allowPrivateFetch, maxBytes: 3_000_000 });
      s.interval = Math.max(60, Number(res.headers.get("x-poll-interval")) || 60);
      if (res.status === 401) { s.ok = false; s.error = "token"; }
      else if (res.status === 304) { s.ok = true; s.error = null; }
      else if (res.status !== 200) { s.ok = false; s.error = `http_${res.status}`; }
      else {
        s.ok = true; s.error = null;
        s.lastModified = res.headers.get("last-modified");
        const list = (JSON.parse(res.body) as any[]).filter((n) => n && typeof n === "object")
          .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
        const seen = new Set(s.seen ?? []);
        const fresh: any[] = [];
        for (const n of list) {
          const key = `${n.id}@${n.updated_at}`;
          if (seen.has(key) || Date.parse(n.updated_at) / 1000 <= s.since) continue;
          seen.add(key);
          const reason = n.reason === "team_mention" ? "mention" : n.reason;
          if ((cur.config.reasons as Record<string, boolean>)[reason]) fresh.push(n);
        }
        for (const n of fresh.slice(0, 3)) {
          const title = String(n.subject?.title ?? "");
          const ci = n.reason === "ci_activity";
          this.svc.sendCard(userId, {
            src: "GitHub", title: REASON_TITLE[n.reason] ?? "GitHub", secs: 45,
            text: `${n.repository?.full_name ?? ""}: ${title}`,
            color: ci ? (/fail|cancel|error/i.test(title) ? "red" : "green") : "purple",
          });
        }
        if (fresh.length > 3) this.svc.sendCard(userId, { src: "GitHub", title: `${fresh.length - 3} more`, text: "notifications on GitHub", color: "purple" });
        s.seen = [...seen].slice(-300);
      }
    } catch (e) { s.ok = false; s.error = errCode(e); }
    s.at = this.now();
    this.putState(userId, "github", s);
    this.due.set(`github:${userId}`, this.now() + (s.interval || 60));
  }

  setStocks(userId: number, raw: unknown) {
    if (!Array.isArray(raw)) throw new HttpError(400, "items");
    if (raw.length > MAX_SYMBOLS) throw new HttpError(400, "too_many");
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : NaN);
    const items: StockItem[] = [];
    for (const it of raw) {
      const symbol = String(it?.symbol ?? "").trim().toUpperCase();
      if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, "symbol");
      const above = num(it.above), below = num(it.below), move = num(it.move);
      if ([above, below, move].some((x) => Number.isNaN(x))) throw new HttpError(400, "level");
      if (items.some((x) => x.symbol === symbol)) throw new HttpError(400, "duplicate");
      items.push({ symbol, above, below, move });
    }
    if (!items.length) { this.remove(userId, "stocks"); return; }
    const cur = this.get<StocksConfig, StocksState>(userId, "stocks");
    const state: StocksState = {};
    for (const it of items) {
      const prev = cur?.state[it.symbol];
      const old = cur?.config.items.find((x) => x.symbol === it.symbol);
      state[it.symbol] = { price: prev?.price, pct: prev?.pct, at: prev?.at, error: prev?.error ?? null,
        aboveSide: old?.above === it.above ? prev?.aboveSide : undefined, belowSide: old?.below === it.below ? prev?.belowSide : undefined,
        movedDay: old?.move === it.move ? prev?.movedDay : undefined };
    }
    this.put(userId, "stocks", { items }, state);
    this.due.set(`stocks:${userId}`, this.now());
  }

  private async quote(symbol: string): Promise<Quote> {
    const cached = this.quotes.get(symbol);
    if (cached && this.now() - cached.at < 120) return cached;
    const res = await safeFetch(`${this.cfg.quotesApi}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; claude-desk-hub)" }, allowPrivate: this.cfg.allowPrivateFetch, maxBytes: 500_000,
    });
    if (res.status === 404) throw new FetchError("unknown_symbol");
    if (res.status !== 200) throw new FetchError(`http_${res.status}`);
    const meta = JSON.parse(res.body)?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice), prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!(price > 0) || !(prev > 0)) throw new FetchError("no_price");
    const q = { price, prev, currency: String(meta?.currency ?? ""), at: this.now() };
    this.quotes.set(symbol, q);
    return q;
  }

  private async pollStocks(userId: number) {
    const cur = this.get<StocksConfig, StocksState>(userId, "stocks");
    if (!cur) return;
    const day = new Date(this.now() * 1000).toISOString().slice(0, 10);
    for (const it of cur.config.items) {
      const s = (cur.state[it.symbol] ??= {});
      try {
        const q = await this.quote(it.symbol);
        const pct = ((q.price - q.prev) / q.prev) * 100;
        const head = `${it.symbol} ${fmtPrice(q.price)}`, change = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% today`;
        if (it.above !== null) {
          const side = q.price >= it.above ? "over" : "under";
          if (s.aboveSide === "under" && side === "over") {
            this.svc.sendCard(userId, { src: "Markets", title: head, text: `${change} · above ${fmtPrice(it.above)}`, color: "green", secs: 45 });
          }
          s.aboveSide = side;
        }
        if (it.below !== null) {
          const side = q.price <= it.below ? "under" : "over";
          if (s.belowSide === "over" && side === "under") {
            this.svc.sendCard(userId, { src: "Markets", title: head, text: `${change} · below ${fmtPrice(it.below)}`, color: "red", secs: 45 });
          }
          s.belowSide = side;
        }
        if (it.move !== null && Math.abs(pct) >= it.move && s.movedDay !== day) {
          this.svc.sendCard(userId, { src: "Markets", title: head, text: `${change} · big move`, color: pct >= 0 ? "green" : "red", secs: 45 });
          s.movedDay = day;
        }
        Object.assign(s, { price: q.price, pct: Math.round(pct * 100) / 100, error: null, at: this.now() });
      } catch (e) {
        Object.assign(s, { error: errCode(e), at: this.now() });
      }
    }
    this.putState(userId, "stocks", cur.state);
    this.due.set(`stocks:${userId}`, this.now() + STOCKS_EVERY_SECS);
  }

  computeNext(userId: number, now = this.now()): NextUp | null {
    const t = this.db.prepare("SELECT label, ends FROM timers WHERE user_id = ? AND ends > ? ORDER BY ends LIMIT 1").get(userId, now) as
      { label: string; ends: number } | undefined;
    if (t) return { text: t.label, at: t.ends, left: true };
    const cal = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    const e = cal?.config.showNext ? this.calEvents(userId).find((x) => x.start > now && x.start - now <= 12 * 3600) : undefined;
    if (e && e.start - now <= 15 * 60) return { text: e.title, at: e.start };
    const p = this.playing.get(userId);
    if (p && this.get<MusicConfig, Status>(userId, p.src)?.config.clock) return { text: p.artist ? `${p.title} · ${p.artist}` : p.title, at: now, kind: "music" };
    if (e) return { text: e.title, at: e.start };
    return null;
  }

  updateNext(userId: number) {
    const n = this.computeNext(userId);
    this.svc.setNext(userId, n);
    if (n) this.nextUsers.add(userId); else this.nextUsers.delete(userId);
  }

  private run(key: string, fn: () => Promise<void>) {
    if (this.inflight.has(key)) return Promise.resolve();
    this.inflight.add(key);
    return fn().catch((e) => this.log(`app ${key} failed`, (e as Error).message)).finally(() => this.inflight.delete(key));
  }

  async tick(): Promise<void> {
    const now = this.now();
    this.fireTimers(now);
    this.fireReminders(now);
    const rows = this.db.prepare("SELECT user_id, kind FROM apps").all() as { user_id: number; kind: string }[];
    const jobs: Promise<void>[] = [];
    for (const r of rows) {
      const key = `${r.kind}:${r.user_id}`;
      if ((this.due.get(key) ?? 0) > now) continue;
      if (r.kind === "calendar") jobs.push(this.run(key, () => this.refreshCalendar(r.user_id)));
      else if (r.kind === "github") jobs.push(this.run(key, () => this.pollGithub(r.user_id)));
      else if (r.kind === "stocks") jobs.push(this.run(key, () => this.pollStocks(r.user_id)));
      else if (r.kind === "rain") jobs.push(this.run(key, () => this.pollRain(r.user_id)));
      else if (r.kind === "email") jobs.push(this.run(key, () => this.pollEmail(r.user_id)));
      else if (r.kind === "slack") jobs.push(this.run(key, () => this.pollSlack(r.user_id)));
      else if (r.kind === "google") jobs.push(this.run(key, () => this.pollGoogle(r.user_id)));
      else if (r.kind === "spotify" || r.kind === "lastfm") {
        if (!this.hasOnlineDesk(r.user_id)) { this.setPlaying(r.user_id, r.kind, null); this.due.set(key, now + 60); continue; }
        jobs.push(this.run(key, () => (r.kind === "spotify" ? this.pollSpotify(r.user_id) : this.pollLastfm(r.user_id))));
      }
    }
    await Promise.all(jobs);
    for (const [u, p] of [...this.playing]) if (p.src === "computer" && now - p.at > COMPUTER_STALE_SECS) this.setPlaying(u, "computer", null);
    for (const [u, x] of [...this.pcEvents]) if (now - x.at > 6 * 3600) { this.pcEvents.delete(u); this.nextUsers.add(u); }
    const users = new Set<number>([...this.nextUsers, ...rows.map((r) => r.user_id),
      ...(this.db.prepare("SELECT DISTINCT user_id FROM timers").all() as { user_id: number }[]).map((r) => r.user_id)]);
    for (const r of rows) if (r.kind === "calendar") this.remindCalendar(r.user_id, this.now());
    for (const u of users) this.updateNext(u);
  }
}
