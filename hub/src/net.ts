import dns from "node:dns";
import net from "node:net";

export class FetchError extends Error {
  constructor(public code: string) { super(code); }
}

export function isPrivateAddress(ip: string): boolean {
  let a = ip.toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (net.isIPv4(a)) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (net.isIPv6(a)) {
    return a === "::" || a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") ||
      a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb") || a.startsWith("ff");
  }
  return true;
}

async function assertPublic(host: string) {
  const h = host.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (isPrivateAddress(h)) throw new FetchError("private_address");
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(h)) throw new FetchError("private_address");
  let addrs: dns.LookupAddress[];
  try { addrs = await dns.promises.lookup(h, { all: true }); } catch { throw new FetchError("dns"); }
  if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) throw new FetchError("private_address");
}

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface FetchResult { status: number; headers: Headers; body: string }

export function normalizeUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://")); } catch { throw new FetchError("bad_url"); }
  return u;
}

export async function safeFetch(raw: string, opts: FetchOpts = {}): Promise<FetchResult> {
  let u = normalizeUrl(raw);
  const max = opts.maxBytes ?? 3 * 1024 * 1024;
  for (let hop = 0; hop < 4; hop++) {
    const httpOk = u.protocol === "https:" || (opts.allowPrivate && u.protocol === "http:");
    if (!httpOk) throw new FetchError("https_only");
    if (!opts.allowPrivate) await assertPublic(u.hostname);
    let res: Response;
    try {
      res = await fetch(u, { redirect: "manual", headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    } catch {
      throw new FetchError("unreachable");
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new FetchError("bad_redirect");
      u = new URL(loc, u);
      continue;
    }
    if (!res.body) return { status: res.status, headers: res.headers, body: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new FetchError("too_big"); }
      chunks.push(value);
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new FetchError("too_many_redirects");
}
