import zlib from "node:zlib";
import sharp from "sharp";
import type { DB } from "./db.js";
import { HttpError, type Service } from "./service.js";
import { RateLimiter } from "./util.js";

export const MEDIA_SIZE = 240;
export const MEDIA_MAX_BYTES = 450 * 1024;
export const MEDIA_MAX_INPUT = 12 * 1024 * 1024;
export const MEDIA_MAX_ITEMS = 30;
const MAX_FRAMES = 240;
const CHUNK = 700;
const HEADER = Buffer.from("DKM1");

export interface EncodedFrame { delay: number; x: number; y: number; w: number; h: number; data: Buffer }

class Out {
  buf: Buffer;
  n = 0;
  constructor(size: number) { this.buf = Buffer.alloc(size); }
  byte(b: number) { this.buf[this.n++] = b; }
  color(c: number) { this.buf.writeUInt16LE(c, this.n); this.n += 2; }
  token(kind: number, count: number) {
    if (count <= 64) this.byte((kind << 6) | (count - 1));
    else { this.byte(0xc0 | (kind << 4) | ((count - 1) >> 8)); this.byte((count - 1) & 0xff); }
  }
}

export function encodeFrame(cur: Uint16Array, prev: Uint16Array | null, size = MEDIA_SIZE): Omit<EncodedFrame, "delay"> {
  let x0 = 0, y0 = 0, x1 = size - 1, y1 = size - 1;
  if (prev) {
    x0 = size; y0 = size; x1 = -1; y1 = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (cur[i] === prev[i]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0, data: Buffer.alloc(0) };
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;
  const at = (k: number) => (y0 + Math.floor(k / w)) * size + x0 + (k % w);
  const same = (k: number) => prev !== null && cur[at(k)] === prev[at(k)];
  const out = new Out(n * 3 + 16);
  const lit: number[] = [];
  const flush = () => {
    for (let i = 0; i < lit.length; i += 4096) {
      const part = lit.slice(i, i + 4096);
      out.token(2, part.length);
      for (const c of part) out.color(c);
    }
    lit.length = 0;
  };
  for (let k = 0; k < n;) {
    if (same(k) && (k + 1 === n || same(k + 1))) {
      flush();
      let r = 0;
      while (k + r < n && same(k + r)) r++;
      for (let left = r; left > 0; left -= 4096) out.token(0, Math.min(left, 4096));
      k += r;
      continue;
    }
    const c = cur[at(k)];
    let r = 1;
    while (k + r < n && cur[at(k + r)] === c) r++;
    if (r >= 3) {
      flush();
      for (let left = r; left > 0; left -= 4096) { out.token(1, Math.min(left, 4096)); out.color(c); }
      k += r;
      continue;
    }
    lit.push(c);
    k++;
  }
  flush();
  return { x: x0, y: y0, w, h, data: out.buf.subarray(0, out.n) };
}

export function packFrames(frames: EncodedFrame[]): Buffer {
  const head = Buffer.alloc(8);
  HEADER.copy(head, 0);
  head.writeUInt16LE(frames.length, 4);
  const parts: Buffer[] = [head];
  for (const f of frames) {
    const fh = Buffer.alloc(10);
    fh.writeUInt16LE(f.delay, 0);
    fh[2] = f.x; fh[3] = f.y; fh[4] = f.w; fh[5] = f.h;
    fh.writeUInt32LE(f.data.length, 6);
    parts.push(fh, f.data);
  }
  return Buffer.concat(parts);
}

export function encodeFrames(pixels: Uint16Array[], delays: number[]): EncodedFrame[] {
  const frames: EncodedFrame[] = [];
  let prev: Uint16Array | null = null;
  pixels.forEach((cur, i) => {
    const f = encodeFrame(cur, prev);
    if (!f.w && frames.length) frames[frames.length - 1].delay = Math.min(60000, frames[frames.length - 1].delay + delays[i]);
    else frames.push({ ...f, delay: delays[i] });
    prev = cur;
  });
  return frames;
}

export async function convertMedia(input: Buffer, fit: "cover" | "contain" = "cover") {
  const opts = { animated: true, limitInputPixels: 60_000_000 };
  let meta: sharp.Metadata;
  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    meta = await sharp(input, opts).metadata();
    raw = await sharp(input, opts).rotate().resize(MEDIA_SIZE, MEDIA_SIZE, { fit, background: "#000" })
      .flatten({ background: "#000" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, "media_unreadable");
  }
  const pages = Math.max(1, Math.round(raw.info.height / MEDIA_SIZE));
  const area = MEDIA_SIZE * MEDIA_SIZE;
  let pick = [...Array(pages).keys()];
  if (pages > MAX_FRAMES) pick = [...Array(MAX_FRAMES).keys()].map((i) => Math.floor((i * pages) / MAX_FRAMES));
  const delayOf = (p: number) => { const d = meta.delay?.[p] ?? 100; return d < 20 ? 100 : Math.min(d, 10000); };
  let pixels = pick.map((p) => {
    const px = new Uint16Array(area);
    const base = p * area * 3;
    for (let i = 0; i < area; i++) {
      const o = base + i * 3;
      px[i] = ((raw.data[o] & 0xf8) << 8) | ((raw.data[o + 1] & 0xfc) << 3) | (raw.data[o + 2] >> 3);
    }
    return px;
  });
  let delays = pick.map((p, i) => {
    const next = pick[i + 1] ?? pages;
    let d = 0;
    for (let q = p; q < next; q++) d += delayOf(q);
    return Math.min(d, 60000);
  });
  let data = packFrames(encodeFrames(pixels, delays));
  while (data.length > MEDIA_MAX_BYTES && pixels.length > 1) {
    pixels = pixels.filter((_, i) => i % 2 === 0);
    delays = delays.reduce<number[]>((acc, d, i) => { if (i % 2 === 0) acc.push(d); else acc[acc.length - 1] = Math.min(60000, acc[acc.length - 1] + d); return acc; }, []);
    data = packFrames(encodeFrames(pixels, delays));
  }
  if (data.length > MEDIA_MAX_BYTES) throw new HttpError(413, "media_too_big");
  const preview = await sharp(input, opts).rotate().resize(160, 160, { fit, background: "#000" }).flatten({ background: "#000" })
    .webp({ quality: 70, effort: 2 }).toBuffer();
  const frames = data.readUInt16LE(4);
  return { data, preview, frames, kind: frames > 1 ? "gif" : "image" as "gif" | "image" };
}

interface MediaRow { id: number; user_id: number; kind: string; data: Buffer; preview: Buffer; frames: number; bytes: number; created: number }

export class Media {
  private seq = 0;
  private gen = new Map<string, number>();
  private status = new Map<string, { seq: number; media: number; state: string; error: string | null; at: number }>();
  private uploadLimiter: RateLimiter;
  private showLimiter: RateLimiter;
  private sendLimiter: RateLimiter;
  pace = 60;

  constructor(private db: DB, private svc: Service, private now: () => number) {
    const nowMs = () => now() * 1000;
    this.uploadLimiter = new RateLimiter(30, 3_600_000, nowMs);
    this.showLimiter = new RateLimiter(60, 3_600_000, nowMs);
    this.sendLimiter = new RateLimiter(20, 3_600_000, nowMs);
  }

  private row(id: number) { return this.db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined; }

  private view(r: MediaRow) { return { id: r.id, kind: r.kind, frames: r.frames, bytes: r.bytes, created: r.created }; }

  async add(me: number, input: Buffer, fit: unknown) {
    if (!input.length) throw new HttpError(400, "media_unreadable");
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM media WHERE user_id = ?").get(me) as { n: number }).n;
    if (count >= MEDIA_MAX_ITEMS) throw new HttpError(400, "media_full");
    if (!this.uploadLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const m = await convertMedia(input, fit === "contain" ? "contain" : "cover");
    const info = this.db.prepare("INSERT INTO media (user_id, kind, data, preview, frames, bytes, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(me, m.kind, m.data, m.preview, m.frames, m.data.length, this.now());
    return this.view(this.row(Number(info.lastInsertRowid))!);
  }

  list(me: number) {
    return (this.db.prepare("SELECT id, user_id, kind, frames, bytes, created FROM media WHERE user_id = ? ORDER BY id DESC").all(me) as MediaRow[])
      .map((r) => this.view(r));
  }

  preview(me: number, id: number): Buffer {
    const r = this.row(id);
    const shared = r && r.user_id !== me && this.db.prepare("SELECT 1 FROM messages WHERE media_id = ? AND (from_id = ? OR to_id = ?) LIMIT 1").get(id, me, me);
    if (!r || (r.user_id !== me && !shared)) throw new HttpError(404, "not_found");
    return Buffer.from(r.preview);
  }

  remove(me: number, id: number) {
    if (!this.db.prepare("DELETE FROM media WHERE id = ? AND user_id = ?").run(id, me).changes) throw new HttpError(404, "not_found");
  }

  private mine(me: number, id: number) {
    const r = this.row(id);
    if (!r || r.user_id !== me) throw new HttpError(404, "not_found");
    return r;
  }

  show(me: number, id: number, secs: unknown) {
    const r = this.mine(me, id);
    if (!this.showLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    return { devices: this.deliver(me, r, "you", secs) };
  }

  send(me: number, id: number, toName: string) {
    const r = this.mine(me, id);
    const to = this.svc.userByName(toName);
    if (!to) throw new HttpError(404, "no_such_user");
    if (to.id === me || !this.svc.relation(me, to.id)) throw new HttpError(403, "not_friends");
    if (!this.sendLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const from = this.svc.userById(me)?.display_name ?? "a friend";
    const devices = this.deliver(to.id, r, from, 60);
    this.svc.markUnread(to.id);
    this.db.prepare("INSERT INTO messages (from_id, to_id, rel, kind, text, reaction, t, media_id) VALUES (?, ?, 'friend', 'media', '', '', ?, ?)")
      .run(me, to.id, this.now(), r.id);
    return { devices };
  }

  hide(me: number) {
    this.svc.setScreen(me, null);
    for (const d of this.svc.devicesOf(me)) {
      this.gen.set(d.chip, (this.gen.get(d.chip) ?? 0) + 1);
      this.svc.broker?.publishRaw(`desk/${d.chip}/media`, Buffer.from([4, 0, 0]));
    }
  }

  ack(chip: string, payload: Buffer) {
    let j: { id?: unknown; ok?: unknown; e?: unknown };
    try { j = JSON.parse(payload.toString("utf8")); } catch { return; }
    const s = this.status.get(chip);
    if (!s || Number(j.id) !== s.seq) return;
    s.state = j.ok === true ? "ok" : "error";
    s.error = j.ok === true ? null : String(j.e ?? "failed").slice(0, 20);
    s.at = this.now();
  }

  deliveries(me: number) {
    return this.svc.devicesOf(me).map((d) => {
      const s = this.status.get(d.chip);
      return { chip: d.chip, media: s?.media ?? null, state: s?.state ?? null, error: s?.error ?? null, at: s?.at ?? null };
    });
  }

  private deliver(userId: number, r: MediaRow, from: string, secsRaw: unknown) {
    const secs = secsRaw === 0 ? 0 : Math.max(10, Math.min(3600, Math.round(Number(secsRaw) || 60)));
    this.svc.setScreen(userId, { kind: r.kind, id: r.id, from, until: secs ? this.now() + secs : null });
    let n = 0;
    for (const d of this.svc.devicesOf(userId)) {
      if (!this.svc.broker?.isOnline(d.chip)) continue;
      n++;
      void this.transfer(d.chip, r, from, secs);
    }
    return n;
  }

  private async transfer(chip: string, r: MediaRow, from: string, secs: number) {
    const gen = (this.gen.get(chip) ?? 0) + 1;
    this.gen.set(chip, gen);
    const seq = this.seq = (this.seq % 65535) + 1;
    this.status.set(chip, { seq, media: r.id, state: "sending", error: null, at: this.now() });
    const data = Buffer.from(r.data);
    const topic = `desk/${chip}/media`;
    const name = Buffer.from(from, "utf8").subarray(0, 40);
    const begin = Buffer.alloc(14);
    begin[0] = 1;
    begin.writeUInt16BE(seq, 1);
    begin.writeUInt32BE(data.length, 3);
    begin.writeUInt32BE(zlib.crc32(data) >>> 0, 7);
    begin.writeUInt16BE(secs, 11);
    begin[13] = name.length;
    const pub = (b: Buffer) => this.svc.broker?.publishRaw(topic, b);
    pub(Buffer.concat([begin, name]));
    for (let off = 0, i = 0; off < data.length; off += CHUNK, i++) {
      if (this.gen.get(chip) !== gen) return;
      const head = Buffer.alloc(7);
      head[0] = 2;
      head.writeUInt16BE(seq, 1);
      head.writeUInt32BE(off, 3);
      pub(Buffer.concat([head, data.subarray(off, off + CHUNK)]));
      if (i % 8 === 7 && this.pace) await new Promise((res) => setTimeout(res, this.pace));
    }
    if (this.gen.get(chip) !== gen) return;
    const end = Buffer.alloc(3);
    end[0] = 3;
    end.writeUInt16BE(seq, 1);
    pub(end);
  }
}
