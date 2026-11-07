import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(got, expected);
}

export const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Constant-time comparison of two strings (compares their SHA-256 so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Random 6-digit code, uniformly distributed. */
export const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** Count Unicode code points (what users think of as characters). */
export const charLen = (s: string) => [...s].length;

/** Truncate to n code points; marks the cut with "..." (the device font is ASCII-only). */
export function trunc(s: unknown, n: number): string {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  const cps = [...str];
  if (cps.length <= n) return str;
  return n > 3 ? cps.slice(0, n - 3).join("") + "..." : cps.slice(0, n).join("");
}

/** Collapse whitespace / control characters to single spaces. */
export const oneLine = (s: unknown) =>
  (typeof s === "string" ? s : s == null ? "" : String(s)).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

/** Fixed-window in-memory rate limiter. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Returns true if allowed (and counts the hit). */
  take(key: string): boolean {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t >= h.reset) {
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
    }
    if (h.n >= this.limit) return false;
    h.n++;
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (t >= v.reset) this.hits.delete(k);
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" (24 h) of unix seconds `t` in IANA timezone `tz` (UTC if invalid). */
export function hhmm(t: number, tz: string): string {
  const zone = isValidTz(tz) ? tz : "UTC";
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(zone, f);
  }
  return f.format(new Date(t * 1000));
}
