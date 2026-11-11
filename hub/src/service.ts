// Domain logic: devices & pairing, Claude Code status, friends, messages.
import type { Broker } from "./broker.js";
import type { Config } from "./config.js";
import { kvGet, kvSet, type DB, type DeviceRow, type FriendRow, type MessageRow, type UserRow } from "./db.js";
import { applyEvent, computeView, viewKey, type HookEvent, type Sessions, type View } from "./state.js";
import type { TlsMaterial } from "./tls.js";
import { charLen, oneLine, randomHex, RateLimiter, safeEqual, sha256, sixDigits, trunc } from "./util.js";
import { MAX_DEVICE_PAYLOAD } from "./broker.js";
import { firmwareInfo, packIndex } from "./files.js";

export const PAIR_ROTATE_SECS = 10 * 60;
export const PAIR_GRACE_SECS = 60;
export const REACTIONS = ["wave", "thumbs", "laugh", "coffee", "fire", "heart", "hug", "kiss", "goodnight", "missyou"] as const;
export const MSG_MAX = 100;
export const OTA_WINDOW_SECS = 5 * 60;
export type Rel = "friend";

/** Remote settings (PROTOCOL.md section 8): key -> validator returning the normalized value or undefined. */
const bit = (v: unknown) => (v === true || v === 1 || v === "1" ? 1 : v === false || v === 0 || v === "0" ? 0 : undefined);
const intIn = (lo: number, hi: number) => (v: unknown) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};
const SETTING_VALIDATORS: Record<string, (v: unknown) => number | undefined> = {
  layout: bit, soft: bit, casper: bit,
  bday: intIn(0, 100), bnight: intIn(0, 100), nstart: intIn(0, 23), nend: intIn(0, 23),
};
export type DeskSettings = Record<string, number | string>;

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** Shrinks string fields (in the given order of preference) until the JSON fits the device limit. */
export function fitPayload<T extends Record<string, unknown>>(obj: T, fields: (keyof T)[], max = MAX_DEVICE_PAYLOAD): T {
  const out = { ...obj };
  for (let guard = 0; Buffer.byteLength(JSON.stringify(out)) > max && guard < 200; guard++) {
    const f = fields.find((k) => typeof out[k] === "string" && (out[k] as string).length > 0);
    if (!f) break;
    const cps = [...(out[f] as string)];
    (out as any)[f] = trunc(out[f], Math.max(0, Math.floor(cps.length * 0.9) - 1));
  }
  return out;
}

export interface CardInput { src?: unknown; title?: unknown; text?: unknown; icon?: unknown; color?: unknown; secs?: unknown }
export interface NextUp { text: string; at: number; left?: boolean; kind?: "music" }
export const CARD_COLORS = ["teal", "orange", "green", "red", "blue", "purple", "pink", "yellow", "white"] as const;

export function normalizeCard(c: CardInput, id: number) {
  const s = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? trunc(oneLine(String(v)), n) : "");
  const icon = typeof c.icon === "string" && (REACTIONS as readonly string[]).includes(c.icon) ? c.icon : "";
  const color = typeof c.color === "string" && ((CARD_COLORS as readonly string[]).includes(c.color) || /^#[0-9a-f]{6}$/i.test(c.color))
    ? c.color.toLowerCase() : "teal";
  const secsNum = Number(c.secs);
  const secs = Number.isFinite(secsNum) ? Math.min(300, Math.max(3, Math.round(secsNum))) : 15;
  return fitPayload({
    id, src: s(c.src, 20).toUpperCase(), title: s(c.title, 40), text: s(c.text, 120), icon, color, secs,
  }, ["text", "title"]);
}

export function versionNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export function deskHostBase(username: string): string {
  return (username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user") + "-desk";
}

interface ClaudeEntry { sessions: Sessions; view: View; key: string }

export class Service {
  private claude = new Map<number, ClaudeEntry>();
  private msgLimiter: RateLimiter;
  private hookLimiter: RateLimiter;
  private cardLimiter: RateLimiter;
  private cardSeq = 0;
  private nextByUser = new Map<number, Record<string, unknown>>();
  private nextKey = new Map<number, string>();
  private baseUrl: string | null;

  constructor(private db: DB, private cfg: Config, private tlsMat: TlsMaterial, public broker: Broker | null = null) {
    const nowMs = () => cfg.now() * 1000;
    this.msgLimiter = new RateLimiter(10, 60_000, nowMs);
    this.hookLimiter = new RateLimiter(600, 60_000, nowMs);
    this.cardLimiter = new RateLimiter(30, 60_000, nowMs);
    this.baseUrl = cfg.publicUrl ?? kvGet(db, "base_url");
    for (const r of db.prepare("SELECT user_id, sessions, view FROM claude_state").all() as any[]) {
      try {
        const view = r.view ? (JSON.parse(r.view) as View) : { s: "idle", p: "", d: "", f: "", t: 0 } as View;
        this.claude.set(r.user_id, { sessions: JSON.parse(r.sessions), view, key: viewKey(view) });
      } catch { /* corrupt row: start fresh */ }
    }
  }

  private now() { return Math.floor(this.cfg.now()); }

  // ------------------------------------------------------------------ hub URL
  /** Public https URL of the hub. Falls back to the last URL seen in a request. */
  hubUrl(fromRequest?: string): string {
    if (this.cfg.publicUrl) return this.cfg.publicUrl;
    if (fromRequest && fromRequest !== this.baseUrl) {
      this.baseUrl = fromRequest;
      kvSet(this.db, "base_url", fromRequest);
    }
    return this.baseUrl ?? fromRequest ?? "";
  }

  // ------------------------------------------------------------------ users
  userById(id: number) { return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined; }
  userByName(username: string) {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(String(username).toLowerCase()) as UserRow | undefined;
  }
  userByHookToken(token: string): UserRow | undefined {
    if (!token || token.length > 128) return undefined;
    const u = this.db.prepare("SELECT * FROM users WHERE hook_token_hash = ?").get(sha256(token)) as UserRow | undefined;
    return u && safeEqual(u.hook_token, token) ? u : undefined;
  }
  newHookToken() { const t = randomHex(32); return { token: t, hash: sha256(t) }; }
  regenerateHookToken(userId: number) {
    const { token, hash } = this.newHookToken();
    this.db.prepare("UPDATE users SET hook_token = ?, hook_token_hash = ? WHERE id = ?").run(token, hash, userId);
    return token;
  }
  setTimezone(userId: number, tz: string, auto: boolean) {
    this.db.prepare("UPDATE users SET tz = ?, tz_auto = ? WHERE id = ?").run(tz, auto ? 1 : 0, userId);
    this.evaluate(userId, true);
  }

  // ------------------------------------------------------------------ devices
  device(chip: string) { return this.db.prepare("SELECT * FROM devices WHERE chip = ?").get(chip) as DeviceRow | undefined; }
  devicesOf(userId: number) {
    return this.db.prepare("SELECT * FROM devices WHERE owner_id = ? ORDER BY created").all(userId) as DeviceRow[];
  }

  deviceAuth(chip: string, secret: string): boolean {
    const d = this.device(chip);
    return !!d && !!secret && safeEqual(sha256(secret), d.secret_hash);
  }

  /** POST /api/device/hello */
  hello(chip: string, fw: string, secret: string, reqUrl: string) {
    const now = this.now();
    this.hubUrl(reqUrl);
    let d = this.device(chip);
    let issued: string | undefined;
    if (!d) {
      issued = randomHex(20);
      this.db.prepare("INSERT INTO devices (chip, secret_hash, fw, last_seen, created) VALUES (?, ?, ?, ?, ?)")
        .run(chip, sha256(issued), fw || null, now, now);
    } else {
      if (!secret || !safeEqual(sha256(secret), d.secret_hash)) throw new HttpError(403, "secret");
      this.db.prepare("UPDATE devices SET fw = COALESCE(?, fw), last_seen = ? WHERE chip = ?").run(fw || null, now, chip);
    }
    this.ensurePairCode(chip, false);
    this.publishCfg(chip);
    d = this.device(chip)!;
    const owner = d.owner_id ? this.userById(d.owner_id) : undefined;
    const res: Record<string, unknown> = {};
    if (issued) res.secret = issued;
    res.paired = !!owner;
    if (!owner) res.pairCode = d.pair_code;
    res.owner = owner ? owner.username : null;
    res.mqtt = {
      host: this.cfg.mqttPublicHost ?? (reqUrl ? new URL(reqUrl).hostname : "localhost"),
      port: this.cfg.mqttPublicPort ?? this.broker?.port ?? this.cfg.mqttPort,
      tls: true,
      fingerprint: this.tlsMat.fingerprint,
      pubkey: this.tlsMat.pubkey,
    };
    return res;
  }

  /** Gives an unpaired device a pair code, rotating it every 10 min. Returns true if it changed. */
  ensurePairCode(chip: string, publish = true): boolean {
    const d = this.device(chip);
    if (!d || d.owner_id) return false;
    const now = this.now();
    if (d.pair_code && d.pair_code_at && now - d.pair_code_at < PAIR_ROTATE_SECS) return false;
    let code = sixDigits();
    const taken = this.db.prepare(
      "SELECT 1 FROM devices WHERE owner_id IS NULL AND (pair_code = ? OR (prev_code = ? AND prev_code_until > ?))");
    for (let i = 0; i < 20 && taken.get(code, code, now); i++) code = sixDigits();
    this.db.prepare("UPDATE devices SET prev_code = pair_code, prev_code_until = ?, pair_code = ?, pair_code_at = ? WHERE chip = ?")
      .run(d.pair_code ? now + PAIR_GRACE_SECS : null, code, now, chip);
    if (publish) this.publishCfg(chip);
    return true;
  }

  pair(userId: number, code: string, name: string) {
    const now = this.now();
    const d = this.db.prepare(
      "SELECT * FROM devices WHERE owner_id IS NULL AND (pair_code = ? OR (prev_code = ? AND prev_code_until > ?))",
    ).get(code, code, now) as DeviceRow | undefined;
    if (!d) throw new HttpError(404, "invalid_code");
    this.db.prepare(`UPDATE devices SET owner_id = ?, name = ?, pair_code = NULL, pair_code_at = NULL, prev_code = NULL,
      prev_code_until = NULL, last_msg_id = NULL, settings = NULL, place = NULL, host = ? WHERE chip = ?`)
      .run(userId, name, this.freeHost(userId, d.chip), d.chip);
    this.republishDevice(d.chip);
    return this.device(d.chip)!;
  }

  private freeHost(userId: number, chip: string): string {
    const owner = this.userById(userId)!;
    const base = deskHostBase(owner.username);
    const taken = new Set((this.db.prepare("SELECT host FROM devices WHERE owner_id = ? AND chip != ? AND host IS NOT NULL")
      .all(userId, chip) as { host: string }[]).map((r) => r.host));
    let host = base;
    for (let n = 2; taken.has(host); n++) host = `${base}-${n}`;
    return host;
  }

  private hostOf(d: DeviceRow): string | null {
    if (!d.owner_id) return null;
    if (d.host) return d.host;
    const host = this.freeHost(d.owner_id, d.chip);
    this.db.prepare("UPDATE devices SET host = ? WHERE chip = ?").run(host, d.chip);
    return host;
  }

  ownedDevice(userId: number, chip: string) {
    const d = this.device(chip);
    if (!d || d.owner_id !== userId) throw new HttpError(404, "not_found");
    return d;
  }

  rename(userId: number, chip: string, name: string) {
    this.ownedDevice(userId, chip);
    this.db.prepare("UPDATE devices SET name = ? WHERE chip = ?").run(name, chip);
    this.publishCfg(chip);
  }

  /** Forget: the device record is deleted; its next hello creates it again (new secret, new pair code). */
  forget(userId: number, chip: string) {
    if (this.otaPending(this.ownedDevice(userId, chip))) throw new HttpError(409, "busy");
    this.db.prepare("DELETE FROM devices WHERE chip = ?").run(chip);
    if (this.broker) {
      this.broker.publish(`desk/${chip}/claude`, null);
      this.broker.publish(`desk/${chip}/msg`, null);
      this.broker.publish(`desk/${chip}/set`, null);
      const broker = this.broker;
      broker.publish(`desk/${chip}/cfg`, { paired: false, pairCode: null, hub: this.hubUrl() }, true, () => broker.kick(chip, 500));
    }
  }

  deviceStatus(chip: string, payload: Buffer) {
    let j: any;
    try { j = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (!j || typeof j !== "object") return;
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    const s = (v: unknown, n: number) => (typeof v === "string" ? trunc(oneLine(v), n) || null : null);
    this.db.prepare(`UPDATE devices SET fw = COALESCE(?, fw), ip = COALESCE(?, ip), rssi = ?, heap = ?, maxblk = ?, up = ?,
      reset = COALESCE(?, reset), last_seen = ? WHERE chip = ?`)
      .run(s(j.fw, 16), s(j.ip, 45), int(j.rssi), int(j.heap), int(j.maxblk), int(j.up), s(j.reset, 40), this.now(), chip);
    const ota = s(j.ota, 80);
    if (ota) this.db.prepare("UPDATE devices SET ota = ?, ota_at = ?, ota_req_at = NULL WHERE chip = ?").run(ota, this.now(), chip);
    const d = this.device(chip);
    if (!ota && d?.ota_req_at && d.fw && d.fw !== d.ota_from) {
      this.db.prepare("UPDATE devices SET ota = ?, ota_at = ?, ota_req_at = NULL WHERE chip = ?")
        .run(trunc(`ok: ${d.ota_from ?? "?"} → ${d.fw}`, 80), this.now(), chip);
    }
  }

  // ------------------------------------------------------------------ remote settings, packs, firmware
  desiredSettings(d: DeviceRow): DeskSettings | null {
    if (!d.settings) return null;
    try { return JSON.parse(d.settings) as DeskSettings; } catch { return null; }
  }

  packs() { return packIndex(this.cfg.packsDir); }

  /** Retained `set` payload: desired settings + packUrl/packMd5 when the pack is a downloadable one. */
  setPayload(settings: DeskSettings | null) {
    if (!settings) return null;
    const out: Record<string, unknown> = { ...settings };
    if (typeof settings.pack === "string" && settings.pack !== "pixel") {
      const p = this.packs().find((x) => x.id === settings.pack);
      if (p) {
        out.packUrl = `${this.hubUrl()}/packs/${p.id}.bin`;
        out.packMd5 = p.md5;
      }
    }
    return out;
  }

  firmware(baseUrl?: string) {
    const f = firmwareInfo(this.cfg.firmwareDir);
    if (!f) return null;
    return { version: f.version, url: `${this.hubUrl(baseUrl)}/firmware/claude-desk.bin`, md5: f.md5, size: f.size };
  }

  /** desk/<chip>/up/settings: what the desk actually runs (stored for the web app). */
  deviceSettingsReport(chip: string, payload: Buffer) {
    let j: any;
    try { j = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (!j || typeof j !== "object" || Array.isArray(j)) return;
    const out: Record<string, unknown> = {};
    for (const [k, fn] of Object.entries(SETTING_VALIDATORS)) { const v = fn(j[k]); if (v !== undefined) out[k] = v; }
    if (typeof j.rev === "number" && Number.isFinite(j.rev)) out.rev = Math.floor(j.rev);
    if (typeof j.pack === "string" && /^[a-z0-9_-]{1,32}$/.test(j.pack)) out.pack = j.pack;
    for (const k of ["lat", "lon"]) if (typeof j[k] === "number" && Number.isFinite(j[k])) out[k] = Math.round(j[k] * 1e4) / 1e4;
    if (Array.isArray(j.packs)) {
      out.packs = j.packs.filter((p: unknown) => typeof p === "string" && /^[a-z0-9_-]{1,32}$/.test(p)).slice(0, 16);
    }
    this.db.prepare("UPDATE devices SET reported = ?, reported_at = ?, last_seen = ? WHERE chip = ?")
      .run(JSON.stringify(out), this.now(), this.now(), chip);
  }

  /** Validates a (partial) settings update from the web app. */
  parseSettings(body: Record<string, unknown>) {
    const set: DeskSettings = {};
    for (const [k, fn] of Object.entries(SETTING_VALIDATORS)) {
      if (body[k] === undefined || body[k] === null) continue;
      const v = fn(body[k]);
      if (v === undefined) throw new HttpError(400, k);
      set[k] = v;
    }
    if (body.pack !== undefined && body.pack !== null) {
      const p = String(body.pack);
      if (p !== "pixel" && !this.packs().some((x) => x.id === p)) throw new HttpError(400, "pack");
      set.pack = p;
    }
    let place: string | null | undefined;
    if (body.lat !== undefined || body.lon !== undefined) {
      const lat = Number(body.lat), lon = Number(body.lon);
      if (body.lat === null || body.lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, "location");
      set.lat = Math.round(lat * 1e4) / 1e4;
      set.lon = Math.round(lon * 1e4) / 1e4;
      place = trunc(oneLine(body.place), 80) || null;
    }
    if (!Object.keys(set).length) throw new HttpError(400, "empty");
    return { set, place };
  }

  /** PUT settings: merge into the desired state, bump rev, publish retained desk/<chip>/set. */
  putSettings(userId: number, chip: string, body: Record<string, unknown>) {
    const d = this.ownedDevice(userId, chip);
    const { set, place } = this.parseSettings(body);
    const prev = this.desiredSettings(d) ?? {};
    const prevRev = typeof prev.rev === "number" ? prev.rev : 0;
    const merged: DeskSettings = { ...prev, ...set, rev: Math.max(this.now(), prevRev + 1) };
    // key order: rev first (matches the protocol example)
    const ordered: DeskSettings = { rev: merged.rev };
    for (const k of ["layout", "soft", "casper", "pack", "bday", "bnight", "nstart", "nend", "lat", "lon"]) {
      if (merged[k] !== undefined) ordered[k] = merged[k];
    }
    this.db.prepare("UPDATE devices SET settings = ?, place = COALESCE(?, place) WHERE chip = ?")
      .run(JSON.stringify(ordered), place === undefined ? null : place, chip);
    if (place === null) this.db.prepare("UPDATE devices SET place = NULL WHERE chip = ?").run(chip);
    const payload = this.setPayload(ordered)!;
    this.broker?.publish(`desk/${chip}/set`, payload);
    return payload;
  }

  settingsView(userId: number, chip: string, baseUrl?: string) {
    const d = this.ownedDevice(userId, chip);
    let reported: unknown = null;
    try { reported = d.reported ? JSON.parse(d.reported) : null; } catch { /* ignore */ }
    return {
      device: this.deviceView(d),
      wifi: this.wifiView(d),
      settings: this.desiredSettings(d),
      place: d.place,
      reported,
      reportedAt: d.reported_at,
      packs: this.packs().map((p) => ({ ...p, preview: `/packs/${p.id}.png` })),
      firmware: this.firmware(baseUrl),
    };
  }

  deviceView(d: DeviceRow) {
    return {
      chip: d.chip, name: d.name, host: this.hostOf(d), fw: d.fw, ip: d.ip, rssi: d.rssi, heap: d.heap, maxblk: d.maxblk,
      reset: d.reset, up: d.up, otaPending: this.otaPending(d),
      lastSeen: d.last_seen, online: this.broker?.isOnline(d.chip) ?? false, ota: d.ota, otaAt: d.ota_at,
    };
  }

  /** desk/<chip>/cmd (not retained): ota | reboot. Only to the owner's own, connected device. */
  otaPending(d: DeviceRow): boolean {
    return !!d.ota_req_at && this.now() - d.ota_req_at < OTA_WINDOW_SECS;
  }

  command(userId: number, chip: string, cmd: "ota" | "reboot", baseUrl?: string) {
    const d = this.ownedDevice(userId, chip);
    if (this.otaPending(d)) throw new HttpError(409, "busy");
    if (!this.broker?.isOnline(chip)) throw new HttpError(409, "offline");
    let payload: Record<string, unknown> = { cmd };
    if (cmd === "ota") {
      const fw = this.firmware(baseUrl);
      if (!fw) throw new HttpError(409, "no_firmware");
      if (d.fw && versionNewer(d.fw, fw.version)) throw new HttpError(409, "downgrade");
      payload = { cmd, url: fw.url, md5: fw.md5, version: fw.version };
      const now = this.now();
      this.db.prepare("UPDATE devices SET ota = ?, ota_at = ?, ota_req_at = ?, ota_from = ? WHERE chip = ?")
        .run(`requested ${fw.version}`, now, now, d.fw, chip);
    }
    this.broker.publish(`desk/${chip}/cmd`, payload, false);
    return payload;
  }

  touchDevice(chip: string) { this.db.prepare("UPDATE devices SET last_seen = ? WHERE chip = ?").run(this.now(), chip); }

  cfgPayload(d: DeviceRow) {
    const owner = d.owner_id ? this.userById(d.owner_id) : undefined;
    const hub = this.hubUrl();
    if (owner) {
      return fitPayload({ paired: true, owner: owner.username, name: d.name ?? "Desk", host: this.hostOf(d), hub }, ["name"]);
    }
    return { paired: false, pairCode: d.pair_code, hub };
  }

  publishCfg(chip: string) {
    const d = this.device(chip);
    if (d && this.broker) this.broker.publish(`desk/${chip}/cfg`, this.cfgPayload(d));
  }

  /** Re-publishes all retained state of one device (cfg, claude, msg). */
  republishDevice(chip: string) {
    const d = this.device(chip);
    if (!d || !this.broker) return;
    this.broker.publish(`desk/${chip}/cfg`, this.cfgPayload(d));
    if (d.owner_id) {
      this.broker.publish(`desk/${chip}/claude`, this.claudeEntry(d.owner_id).view);
      const m = d.last_msg_id
        ? (this.db.prepare("SELECT * FROM messages WHERE id = ?").get(d.last_msg_id) as MessageRow | undefined) : undefined;
      this.broker.publish(`desk/${chip}/msg`, m ? this.msgPayload(m) : null);
      this.broker.publish(`desk/${chip}/set`, this.setPayload(this.desiredSettings(d)));
      this.broker.publish(`desk/${chip}/next`, this.nextByUser.get(d.owner_id) ?? null);
    } else {
      this.broker.publish(`desk/${chip}/claude`, null);
      this.broker.publish(`desk/${chip}/msg`, null);
      this.broker.publish(`desk/${chip}/set`, null);
      this.broker.publish(`desk/${chip}/next`, null);
    }
  }

  sendCard(userId: number, input: CardInput): { devices: number; limited: boolean } {
    if (!this.cardLimiter.take(String(userId))) return { devices: 0, limited: true };
    const card = normalizeCard(input, ++this.cardSeq);
    let devices = 0;
    for (const d of this.devicesOf(userId)) {
      this.broker?.publish(`desk/${d.chip}/card`, card, false);
      devices++;
    }
    return { devices, limited: false };
  }

  setNext(userId: number, next: NextUp | null) {
    const payload = !next ? null : next.kind === "music"
      ? { text: trunc(oneLine(next.text), 38), at: 0, left: false, k: "music" }
      : { text: trunc(oneLine(next.text), 24), at: Math.floor(next.at), left: !!next.left };
    const key = JSON.stringify(payload);
    if ((this.nextKey.get(userId) ?? "null") === key) return;
    this.nextKey.set(userId, key);
    if (payload) this.nextByUser.set(userId, payload); else this.nextByUser.delete(userId);
    for (const d of this.devicesOf(userId)) this.broker?.publish(`desk/${d.chip}/next`, payload);
  }

  deviceWifi(chip: string, payload: Buffer) {
    let j: any;
    try { j = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (!j || typeof j !== "object") return;
    const ssid = (v: unknown) => (typeof v === "string" ? v.slice(0, 32) : "");
    const prev = this.wifiView(this.device(chip));
    const out = {
      saved: Array.isArray(j.saved) ? j.saved.map(ssid).filter(Boolean).slice(0, 8) : [],
      current: ssid(j.current),
      rssi: typeof j.rssi === "number" ? Math.round(j.rssi) : null,
      visible: Array.isArray(j.visible)
        ? j.visible.filter((v: any) => v && typeof v === "object").map((v: any) => ({ ssid: ssid(v.s), rssi: Number(v.r) || 0, open: v.o === 1 }))
          .filter((v: any) => v.ssid).slice(0, 30)
        : prev?.visible ?? [],
      scannedAt: Array.isArray(j.visible) ? this.now() : prev?.scannedAt ?? null,
    };
    this.db.prepare("UPDATE devices SET wifi = ?, wifi_at = ? WHERE chip = ?").run(JSON.stringify(out), this.now(), chip);
  }

  wifiView(d: DeviceRow | undefined) {
    if (!d?.wifi) return null;
    try { return { ...JSON.parse(d.wifi), at: d.wifi_at } as { saved: string[]; current: string; rssi: number | null;
      visible: { ssid: string; rssi: number; open: boolean }[]; scannedAt: number | null; at: number | null }; } catch { return null; }
  }

  wifiCommand(userId: number, chip: string, cmd: "wifi_scan" | "wifi_add" | "wifi_del", ssid = "", pass = "") {
    const d = this.ownedDevice(userId, chip);
    if (this.otaPending(d)) throw new HttpError(409, "busy");
    if (!this.broker?.isOnline(chip)) throw new HttpError(409, "offline");
    if (cmd !== "wifi_scan") {
      if (!ssid || Buffer.byteLength(ssid) > 32) throw new HttpError(400, "ssid");
      if (cmd === "wifi_add" && pass && (pass.length < 8 || pass.length > 63)) throw new HttpError(400, "wifi_pass");
    }
    const payload: Record<string, string> = { cmd };
    if (cmd !== "wifi_scan") payload.ssid = ssid;
    if (cmd === "wifi_add") payload.pass = pass;
    this.broker.publish(`desk/${chip}/cmd`, payload, false);
  }

  republishAll() {
    for (const r of this.db.prepare("SELECT chip FROM devices").all() as { chip: string }[]) this.republishDevice(r.chip);
  }

  deviceOnline(chip: string) {
    this.touchDevice(chip);
    if (!this.ensurePairCode(chip, false)) { /* unchanged */ }
    this.republishDevice(chip);
  }

  // ------------------------------------------------------------------ Claude Code status
  private claudeEntry(userId: number): ClaudeEntry {
    let e = this.claude.get(userId);
    if (!e) {
      const view: View = { s: "idle", p: "", d: "", f: "", t: 0 };
      e = { sessions: {}, view, key: viewKey(view) };
      this.claude.set(userId, e);
    }
    return e;
  }

  hookAllowed(userId: number) { return this.hookLimiter.take(String(userId)); }

  hookEvent(user: UserRow, ev: HookEvent) {
    const e = this.claudeEntry(user.id);
    applyEvent(e.sessions, ev, this.cfg.now());
    this.persistClaude(user.id, e);
    this.evaluate(user.id);
  }

  private persistClaude(userId: number, e: ClaudeEntry) {
    this.db.prepare(`INSERT INTO claude_state (user_id, sessions, view) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET sessions = excluded.sessions, view = excluded.view`)
      .run(userId, JSON.stringify(e.sessions), JSON.stringify(e.view));
  }

  /** Recomputes a user's view; publishes to all their devices if it changed (or if forced). */
  evaluate(userId: number, force = false) {
    const e = this.claudeEntry(userId);
    const user = this.userById(userId);
    if (!user) { this.claude.delete(userId); return; }
    const before = Object.keys(e.sessions).length;
    const v = computeView(e.sessions, this.cfg.now(), user.tz);
    if (v.s === "idle") v.t = this.now();
    const k = viewKey(v);
    const pruned = Object.keys(e.sessions).length !== before;
    if (k === e.key && !force) {
      if (pruned) this.persistClaude(userId, e);
      return;
    }
    e.view = fitPayload(v as unknown as Record<string, unknown>, ["d", "p", "f"]) as unknown as View;
    e.key = k;
    this.persistClaude(userId, e);
    if (!this.broker) return;
    for (const d of this.devicesOf(userId)) this.broker.publish(`desk/${d.chip}/claude`, e.view);
  }

  claudeView(userId: number) { return this.claudeEntry(userId).view; }

  /** 1 s timer: done -> working/idle transitions, TTLs, pair-code rotation for connected devices. */
  tick() {
    for (const [uid, e] of this.claude) {
      if (Object.keys(e.sessions).length || e.view.s !== "idle") this.evaluate(uid);
    }
    if (this.broker) {
      const stale = this.db.prepare(
        "SELECT chip FROM devices WHERE owner_id IS NULL AND (pair_code_at IS NULL OR pair_code_at <= ?)",
      ).all(this.now() - PAIR_ROTATE_SECS) as { chip: string }[];
      for (const { chip } of stale) if (this.broker.isOnline(chip)) this.ensurePairCode(chip, true);
    }
  }

  /** Hourly housekeeping. */
  housekeeping() {
    const now = this.now();
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(now);
    // devices that said hello but were never paired nor seen for a week
    for (const r of this.db.prepare("SELECT chip FROM devices WHERE owner_id IS NULL AND COALESCE(last_seen, created) < ?")
      .all(now - 7 * 86400) as { chip: string }[]) {
      if (this.broker?.isOnline(r.chip)) continue;
      this.db.prepare("DELETE FROM devices WHERE chip = ?").run(r.chip);
    }
  }

  // ------------------------------------------------------------------ friends
  private pairKey(x: number, y: number): [number, number] { return x < y ? [x, y] : [y, x]; }
  private friendRow(x: number, y: number) {
    const [a, b] = this.pairKey(x, y);
    return this.db.prepare("SELECT * FROM friends WHERE a = ? AND b = ?").get(a, b) as FriendRow | undefined;
  }

  relation(x: number, y: number): Rel | null { return this.friendRow(x, y)?.rel ?? null; }

  friendView(me: number, r: FriendRow) {
    const other = this.userById(r.a === me ? r.b : r.a)!;
    return {
      username: other.username,
      displayName: other.display_name,
      rel: r.rel,
      pendingRel: r.pending_rel,
      pendingFrom: r.pending_rel ? (r.pending_from === me ? "me" : "them") : null,
    };
  }

  listFriends(me: number) {
    const rows = this.db.prepare("SELECT * FROM friends WHERE a = ? OR b = ?").all(me, me) as FriendRow[];
    return rows.map((r) => this.friendView(me, r)).sort((x, y) => x.username.localeCompare(y.username));
  }

  requestFriend(me: number, username: string) {
    const other = this.userByName(username);
    if (!other) throw new HttpError(404, "no_such_user");
    if (other.id === me) throw new HttpError(400, "self");
    const [a, b] = this.pairKey(me, other.id);
    const r = this.friendRow(me, other.id);
    const now = this.now();
    if (!r) {
      this.db.prepare("INSERT INTO friends (a, b, rel, pending_rel, pending_from, updated) VALUES (?, ?, NULL, 'friend', ?, ?)")
        .run(a, b, me, now);
    } else if (!r.rel && r.pending_from === other.id) {
      this.db.prepare("UPDATE friends SET rel = 'friend', pending_rel = NULL, pending_from = NULL, updated = ? WHERE a = ? AND b = ?")
        .run(now, a, b);
    }
    return this.friendView(me, this.friendRow(me, other.id)!);
  }

  acceptFriend(me: number, username: string) {
    const other = this.userByName(username);
    const r = other && this.friendRow(me, other.id);
    if (!other || !r || !r.pending_rel || r.pending_from !== other.id) throw new HttpError(404, "no_request");
    this.db.prepare("UPDATE friends SET rel = 'friend', pending_rel = NULL, pending_from = NULL, updated = ? WHERE a = ? AND b = ?")
      .run(this.now(), r.a, r.b);
    return this.friendView(me, this.friendRow(me, other.id)!);
  }

  /** Declines an incoming request or cancels an outgoing one. The existing relationship (if any) stays. */
  declineFriend(me: number, username: string) {
    const other = this.userByName(username);
    const r = other && this.friendRow(me, other.id);
    if (!other || !r || !r.pending_rel) throw new HttpError(404, "no_request");
    if (r.rel) {
      this.db.prepare("UPDATE friends SET pending_rel = NULL, pending_from = NULL, updated = ? WHERE a = ? AND b = ?")
        .run(this.now(), r.a, r.b);
    } else {
      this.db.prepare("DELETE FROM friends WHERE a = ? AND b = ?").run(r.a, r.b);
    }
  }

  removeFriend(me: number, username: string) {
    const other = this.userByName(username);
    const r = other && this.friendRow(me, other.id);
    if (!other || !r) throw new HttpError(404, "not_found");
    this.db.prepare("DELETE FROM friends WHERE a = ? AND b = ?").run(r.a, r.b);
  }

  // ------------------------------------------------------------------ messages
  msgPayload(m: MessageRow) {
    const from = this.userById(m.from_id);
    return fitPayload({
      id: m.id,
      from: from?.username ?? "?",
      name: trunc(from?.display_name ?? "?", 20),
      rel: m.rel,
      kind: m.kind,
      text: m.text,
      reaction: m.reaction,
      t: m.t,
    }, ["text", "name"]);
  }

  apiMessage(me: number, m: MessageRow) {
    const from = this.userById(m.from_id);
    const to = this.userById(m.to_id);
    return {
      id: m.id, from: from?.username, to: to?.username, mine: m.from_id === me,
      rel: m.rel, kind: m.kind, text: m.text, reaction: m.reaction, t: m.t,
      doodle: m.kind === "doodle" && m.doodle_id
        ? Buffer.from((this.db.prepare("SELECT data FROM doodles WHERE id = ?").get(m.doodle_id) as { data: Buffer } | undefined)?.data ?? Buffer.alloc(0)).toString("base64")
        : undefined,
      media: m.kind === "media" && m.media_id
        ? { id: m.media_id, kind: (this.db.prepare("SELECT kind FROM media WHERE id = ?").get(m.media_id) as { kind: string } | undefined)?.kind ?? null }
        : undefined,
    };
  }

  sendMessage(me: number, toName: string, kind: unknown, text: unknown, reaction: unknown) {
    const to = this.userByName(String(toName ?? ""));
    if (!to) throw new HttpError(404, "no_such_user");
    const rel = this.relation(me, to.id);
    if (!rel) throw new HttpError(403, "not_friends");
    let t = "";
    let r = "";
    if (kind === "text") {
      t = oneLine(text);
      if (!t) throw new HttpError(400, "empty");
      if (charLen(t) > MSG_MAX) throw new HttpError(400, "too_long");
    } else if (kind === "reaction") {
      r = String(reaction ?? "");
      if (!(REACTIONS as readonly string[]).includes(r)) throw new HttpError(400, "bad_reaction");
    } else {
      throw new HttpError(400, "bad_kind");
    }
    if (!this.msgLimiter.take(String(me))) throw new HttpError(429, "rate_limited");
    const now = this.now();
    const info = this.db.prepare("INSERT INTO messages (from_id, to_id, rel, kind, text, reaction, t) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(me, to.id, rel, kind, t, r, now);
    const m = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid) as MessageRow;
    const payload = this.msgPayload(m);
    let delivered = 0;
    for (const d of this.devicesOf(to.id)) {
      this.db.prepare("UPDATE devices SET last_msg_id = ? WHERE chip = ?").run(m.id, d.chip);
      this.broker?.publish(`desk/${d.chip}/msg`, payload);
      delivered++;
    }
    return { message: this.apiMessage(me, m), devices: delivered };
  }

  history(me: number, withName: string) {
    const other = this.userByName(String(withName ?? ""));
    if (!other) throw new HttpError(404, "no_such_user");
    const rows = this.db.prepare(`SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
      ORDER BY id DESC LIMIT 50`).all(me, other.id, other.id, me) as MessageRow[];
    return rows.map((m) => this.apiMessage(me, m));
  }
}
