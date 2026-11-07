import ical from "node-ical";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { FetchError, normalizeUrl, safeFetch } from "./net.js";
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
        upcoming: (this.events.get(userId) ?? []).filter((e) => e.start > now).slice(0, 3).map((e) => ({ title: e.title, start: e.start })),
      },
      github: gh
        ? { connected: true, login: gh.config.login, reasons: gh.config.reasons, ok: gh.state.ok ?? null, error: gh.state.error ?? null, at: gh.state.at ?? null }
        : { connected: false, login: null, reasons: Object.fromEntries(GITHUB_REASONS.map((r) => [r, r !== "comment"])), ok: null, error: null, at: null },
      stocks: {
        items: st?.config.items ?? [],
        quotes: Object.fromEntries(Object.entries(st?.state ?? {}).map(([k, s]) => [k, { price: s.price ?? null, pct: s.pct ?? null, error: s.error ?? null, at: s.at ?? null }])),
      },
    };
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
    if (!cur.config.feeds.length) { this.remove(userId, "calendar"); this.events.delete(userId); }
    else { this.put(userId, "calendar", cur.config, cur.state); this.due.delete(`calendar:${userId}`); }
    this.updateNext(userId);
  }

  setCalendarOptions(userId: number, b: { remind?: unknown; showNext?: unknown }) {
    const cur = this.get<CalendarConfig, CalendarState>(userId, "calendar");
    if (!cur) throw new HttpError(404, "not_found");
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
    for (const e of this.events.get(userId) ?? []) {
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
    if (cal?.config.showNext) {
      const e = (this.events.get(userId) ?? []).find((x) => x.start > now && x.start - now <= 12 * 3600);
      if (e) return { text: e.title, at: e.start };
    }
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
    const rows = this.db.prepare("SELECT user_id, kind FROM apps").all() as { user_id: number; kind: string }[];
    const jobs: Promise<void>[] = [];
    for (const r of rows) {
      const key = `${r.kind}:${r.user_id}`;
      if ((this.due.get(key) ?? 0) > now) continue;
      if (r.kind === "calendar") jobs.push(this.run(key, () => this.refreshCalendar(r.user_id)));
      else if (r.kind === "github") jobs.push(this.run(key, () => this.pollGithub(r.user_id)));
      else if (r.kind === "stocks") jobs.push(this.run(key, () => this.pollStocks(r.user_id)));
    }
    await Promise.all(jobs);
    const users = new Set<number>([...this.nextUsers, ...rows.map((r) => r.user_id),
      ...(this.db.prepare("SELECT DISTINCT user_id FROM timers").all() as { user_id: number }[]).map((r) => r.user_id)]);
    for (const r of rows) if (r.kind === "calendar") this.remindCalendar(r.user_id, this.now());
    for (const u of users) this.updateNext(u);
  }
}
