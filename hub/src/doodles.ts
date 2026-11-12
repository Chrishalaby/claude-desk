import type { DB } from "./db.js";
import { HttpError, type Service } from "./service.js";
import { RateLimiter } from "./util.js";

export const DOODLE_MAX_BYTES = 48 * 1024;
export const DOODLE_IDLE_SECS = 30 * 60;
export const DOODLE_RESYNC_SECS = 100;
export const DOODLE_COLORS = 12;
const CHUNK = 700;

type Listener = (event: string, data: Record<string, unknown>) => void;
interface Op { by: number; k: number; bytes: Buffer }
interface Session { id: number; a: number; b: number; data: Buffer; ops: Op[]; last: number; listeners: Set<Listener> }
interface DoodleRow { id: number; a: number; b: number; data: Buffer; started: number; ended: number | null }

export function validStrokes(buf: Buffer): boolean {
  if (!buf.length || (buf[0] !== 0xff && buf[0] !== 0xfe)) return false;
  let inStroke = false;
  for (let i = 0; i < buf.length;) {
    if (buf[i] === 0xfe) {
      if (i + 1 >= buf.length || buf[i + 1] >= DOODLE_COLORS) return false;
      inStroke = false;
      i += 2;
      continue;
    }
    if (buf[i] === 0xff) {
      inStroke = true;
      if (i + 2 >= buf.length || buf[i + 1] >= DOODLE_COLORS || buf[i + 2] < 1 || buf[i + 2] > 24) return false;
      i += 3;
      continue;
    }
    if (!inStroke || i + 1 >= buf.length || buf[i] > 239 || buf[i + 1] > 239) return false;
    i += 2;
  }
  return true;
}

export function chunkStrokes(buf: Buffer, max = CHUNK): Buffer[] {
  const out: Buffer[] = [];
  let cur: number[] = [];
  let head: number[] | null = null;
  let last: number[] | null = null;
  const flush = () => { if (cur.length) out.push(Buffer.from(cur)); cur = []; };
  for (let i = 0; i < buf.length;) {
    if (buf[i] === 0xfe) {
      if (cur.length + 2 > max) flush();
      cur.push(0xfe, buf[i + 1]);
      head = null;
      last = null;
      i += 2;
      continue;
    }
    if (buf[i] === 0xff) {
      head = [0xff, buf[i + 1], buf[i + 2]];
      last = null;
      if (cur.length + 5 > max) flush();
      cur.push(...head);
      i += 3;
      continue;
    }
    const pt = [buf[i], buf[i + 1]];
    if (cur.length + 2 > max) {
      flush();
      cur.push(...head!);
      if (last) cur.push(...last);
    }
    cur.push(...pt);
    last = pt;
    i += 2;
  }
  flush();
  return out;
}

export class Doodles {
  private sessions = new Map<number, Session>();
  private shown = new Map<number, number>();
  private startLimiter: RateLimiter;
  private strokeLimiter: RateLimiter;

  constructor(private db: DB, private svc: Service, private now: () => number) {
    const nowMs = () => now() * 1000;
    this.startLimiter = new RateLimiter(30, 3_600_000, nowMs);
    this.strokeLimiter = new RateLimiter(1200, 60_000, nowMs);
  }

  private row(id: number) { return this.db.prepare("SELECT * FROM doodles WHERE id = ?").get(id) as DoodleRow | undefined; }

  private publish(userId: number, payload: Buffer) {
    for (const d of this.svc.devicesOf(userId)) this.svc.broker?.publishRaw(`desk/${d.chip}/draw`, payload);
  }

  private head(op: number, id: number) { return Buffer.from([op, (id >> 8) & 0xff, id & 0xff]); }

  private deskStart(s: { id: number; a: number; b: number }) {
    const pairs = s.a === s.b ? [[s.a, s.a]] : [[s.a, s.b], [s.b, s.a]];
    for (const [owner, other] of pairs) {
      const name = owner === other ? "you" : this.svc.userById(other)?.display_name ?? "a friend";
      const nb = Buffer.from(name, "utf8").subarray(0, 40);
      this.shown.set(owner, s.id);
      this.svc.setScreen(owner, { kind: "drawing", id: s.id, from: name, until: this.now() + 120, live: true });
      if (owner !== other) this.svc.markUnread(owner);
      this.publish(owner, Buffer.concat([this.head(1, s.id), Buffer.from([nb.length]), nb]));
    }
  }

  private toBoth(s: { a: number; b: number }, payload: Buffer) {
    this.publish(s.a, payload);
    if (s.b !== s.a) this.publish(s.b, payload);
  }

  private emit(s: Session, event: string, data: Record<string, unknown>) {
    for (const l of s.listeners) { try { l(event, data); } catch { s.listeners.delete(l); } }
  }

  private session(me: number, id: number): Session {
    const s = this.sessions.get(id);
    if (!s || (s.a !== me && s.b !== me)) throw new HttpError(404, "not_found");
    return s;
  }

  view(me: number, id: number) {
    const r = this.row(id);
    if (!r || (r.a !== me && r.b !== me)) throw new HttpError(404, "not_found");
    const other = this.svc.userById(r.a === me ? r.b : r.a);
    return { id: r.id, with: r.a === r.b ? null : other?.username ?? null, withName: r.a === r.b ? null : other?.display_name ?? null,
      open: this.sessions.has(id), data: Buffer.from(r.data).toString("base64"), started: r.started, ended: r.ended };
  }

  start(me: number, toName: string | null) {
    let other = me;
    if (toName) {
      const to = this.svc.userByName(toName);
      if (!to) throw new HttpError(404, "no_such_user");
      if (to.id !== me && !this.svc.relation(me, to.id)) throw new HttpError(403, "not_friends");
      other = to.id;
    }
    for (const s of this.sessions.values()) {
      if ((s.a === me && s.b === other) || (s.a === other && s.b === me)) return { id: s.id, joined: true };
    }
    if (!this.startLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const now = this.now();
    const info = this.db.prepare("INSERT INTO doodles (a, b, data, started) VALUES (?, ?, ?, ?)").run(me, other, Buffer.alloc(0), now);
    const s: Session = { id: Number(info.lastInsertRowid), a: me, b: other, data: Buffer.alloc(0), ops: [], last: now, listeners: new Set() };
    this.sessions.set(s.id, s);
    this.deskStart(s);
    return { id: s.id, joined: false };
  }

  active(me: number) {
    return [...this.sessions.values()].filter((s) => s.a === me || s.b === me).map((s) => {
      const other = this.svc.userById(s.a === me ? s.b : s.a);
      return { id: s.id, with: s.a === s.b ? null : other?.username ?? null, withName: s.a === s.b ? null : other?.display_name ?? null,
        startedByMe: s.a === me };
    });
  }

  addStrokes(me: number, id: number, b64: unknown, k?: unknown) {
    const s = this.session(me, id);
    if (!this.strokeLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const bytes = typeof b64 === "string" && b64.length <= 8192 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
    if (!validStrokes(bytes)) throw new HttpError(400, "strokes");
    if (s.data.length + bytes.length > DOODLE_MAX_BYTES) throw new HttpError(413, "too_big");
    if (this.now() - s.last > DOODLE_RESYNC_SECS) this.resend(s);
    s.data = Buffer.concat([s.data, bytes]);
    s.ops.push({ by: me, k: Number.isSafeInteger(k) ? Number(k) : -1 - s.ops.length, bytes });
    s.last = this.now();
    this.db.prepare("UPDATE doodles SET data = ? WHERE id = ?").run(s.data, s.id);
    for (const c of chunkStrokes(bytes)) this.toBoth(s, Buffer.concat([this.head(2, s.id), c]));
    for (const u of new Set([s.a, s.b])) this.svc.setScreen(u, { kind: "drawing", id: s.id, from: this.fromFor(u, s), until: this.now() + 120, live: true });
    this.emit(s, "strokes", { by: this.svc.userById(me)?.username, s: bytes.toString("base64") });
  }

  clear(me: number, id: number) {
    const s = this.session(me, id);
    s.data = Buffer.alloc(0);
    s.ops = [];
    s.last = this.now();
    this.db.prepare("UPDATE doodles SET data = ? WHERE id = ?").run(s.data, s.id);
    this.toBoth(s, this.head(4, s.id));
    this.emit(s, "clear", { by: this.svc.userById(me)?.username });
  }

  undo(me: number, id: number) {
    const s = this.session(me, id);
    const lastMine = [...s.ops].reverse().find((o) => o.by === me);
    if (!lastMine) return { undone: false };
    s.ops = s.ops.filter((o) => !(o.by === me && o.k === lastMine.k));
    s.data = Buffer.concat(s.ops.map((o) => o.bytes));
    s.last = this.now();
    this.db.prepare("UPDATE doodles SET data = ? WHERE id = ?").run(s.data, s.id);
    this.toBoth(s, this.head(4, s.id));
    for (const c of chunkStrokes(s.data)) this.toBoth(s, Buffer.concat([this.head(2, s.id), c]));
    this.emit(s, "reset", { by: this.svc.userById(me)?.username, s: s.data.toString("base64") });
    return { undone: true };
  }

  private fromFor(owner: number, s: { a: number; b: number }) {
    return s.a === s.b ? "you" : this.svc.userById(owner === s.a ? s.b : s.a)?.display_name ?? "a friend";
  }

  private endFrame(id: number, secs: number) {
    const t = secs === 0 ? 0 : Math.max(10, Math.min(3600, Math.round(secs)));
    return Buffer.concat([this.head(3, id), Buffer.from([(t >> 8) & 0xff, t & 0xff])]);
  }

  end(me: number, id: number, secs = 60) {
    const s = this.session(me, id);
    this.finish(s, secs);
  }

  private finish(s: Session, secs: number) {
    this.sessions.delete(s.id);
    const now = this.now();
    this.db.prepare("UPDATE doodles SET ended = ? WHERE id = ?").run(now, s.id);
    this.toBoth(s, this.endFrame(s.id, secs));
    const until = secs === 0 ? null : now + Math.max(10, Math.min(3600, Math.round(secs)));
    for (const u of new Set([s.a, s.b])) this.svc.setScreen(u, { kind: "drawing", id: s.id, from: this.fromFor(u, s), until });
    this.emit(s, "end", {});
    for (const l of s.listeners) s.listeners.delete(l);
    if (s.data.length && s.a !== s.b) {
      this.db.prepare("INSERT INTO messages (from_id, to_id, rel, kind, text, reaction, t, doodle_id) VALUES (?, ?, 'friend', 'doodle', '', '', ?, ?)")
        .run(s.a, s.b, now, s.id);
    }
    if (!s.data.length) this.db.prepare("DELETE FROM doodles WHERE id = ?").run(s.id);
  }

  subscribe(me: number, id: number, l: Listener): () => void {
    const s = this.session(me, id);
    s.listeners.add(l);
    return () => s.listeners.delete(l);
  }

  mine(me: number) {
    return (this.db.prepare("SELECT id, data, started FROM doodles WHERE a = ? AND b = ? AND ended IS NOT NULL ORDER BY id DESC LIMIT 20")
      .all(me, me) as { id: number; data: Buffer; started: number }[]).map((r) => ({ id: r.id, data: Buffer.from(r.data).toString("base64"), started: r.started }));
  }

  show(me: number, id: number, secs: number) {
    const r = this.row(id);
    if (!r || (r.a !== me && r.b !== me) || !r.data.length) throw new HttpError(404, "not_found");
    if (!this.startLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const nb = Buffer.from("you", "utf8");
    this.shown.set(me, r.id);
    this.svc.setScreen(me, { kind: "drawing", id: r.id, from: "you", until: secs === 0 ? null : this.now() + Math.max(10, Math.min(3600, Math.round(secs))) });
    this.publish(me, Buffer.concat([this.head(1, r.id), Buffer.from([nb.length]), nb]));
    for (const c of chunkStrokes(Buffer.from(r.data))) this.publish(me, Buffer.concat([this.head(2, r.id), c]));
    this.publish(me, this.endFrame(r.id, secs));
  }

  hide(me: number) {
    for (const s of [...this.sessions.values()]) if (s.a === me && s.b === me) this.finish(s, 10);
    const id = this.shown.get(me) ?? 0;
    this.publish(me, this.endFrame(id, 10));
    this.publish(me, this.head(5, id));
    this.svc.setScreen(me, null);
  }

  remove(me: number, id: number) {
    const r = this.row(id);
    if (!r || r.a !== me || r.b !== me) throw new HttpError(404, "not_found");
    this.db.prepare("DELETE FROM doodles WHERE id = ?").run(id);
  }

  private resend(s: Session) {
    for (const owner of new Set([s.a, s.b])) {
      const nb = Buffer.from(this.fromFor(owner, s), "utf8").subarray(0, 40);
      this.shown.set(owner, s.id);
      this.publish(owner, Buffer.concat([this.head(1, s.id), Buffer.from([nb.length]), nb]));
      for (const c of chunkStrokes(s.data)) this.publish(owner, Buffer.concat([this.head(2, s.id), c]));
    }
  }

  tick() {
    const now = this.now();
    for (const s of [...this.sessions.values()]) if (now - s.last > DOODLE_IDLE_SECS) this.finish(s, 60);
  }
}
