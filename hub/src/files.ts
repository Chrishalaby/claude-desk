// Firmware image and emoji packs served from files in the repo (hashed at startup, re-read when they change).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PACK_ID_RE = /^[a-z0-9_-]{1,32}$/;

export interface Blob { body: Buffer; md5: string; size: number; mtimeMs: number }

const cache = new Map<string, Blob | null>();

/** Reads a file (cached; re-read when size/mtime change). Null if missing. */
export function readBlob(file: string): Blob | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  if (!st.isFile()) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const body = fs.readFileSync(file);
  const b = { body, md5: crypto.createHash("md5").update(body).digest("hex"), size: body.length, mtimeMs: st.mtimeMs };
  cache.set(file, b);
  return b;
}

export interface FirmwareInfo { version: string; md5: string; size: number }

/** Latest firmware = firmware/dist/claude-desk.bin + version.txt; null unless both exist. */
export function firmwareInfo(dir: string): (FirmwareInfo & { blob: Blob }) | null {
  const blob = readBlob(path.join(dir, "claude-desk.bin"));
  if (!blob) return null;
  let version = "";
  try { version = fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim().split(/\s+/)[0] ?? ""; } catch { /* absent */ }
  if (!version || version.length > 32) return null;
  return { version, md5: blob.md5, size: blob.size, blob };
}

export interface PackInfo { id: string; name: string; license: string; size: number; md5: string }

/**
 * Pack index: entries of packs/index.json (names, licenses) whose .bin exists, with size/md5 computed from
 * the file. .bin files missing from index.json are listed with their id as name.
 */
export function packIndex(dir: string): PackInfo[] {
  let listed: any[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    if (Array.isArray(j?.packs)) listed = j.packs;
  } catch { /* absent or invalid */ }
  let bins: string[] = [];
  try { bins = fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).map((f) => f.slice(0, -4)); } catch { /* no dir */ }
  const out: PackInfo[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: unknown, license: unknown) => {
    if (seen.has(id) || !PACK_ID_RE.test(id) || id === "pixel") return;
    const b = readBlob(path.join(dir, id + ".bin"));
    if (!b) return;
    seen.add(id);
    out.push({
      id,
      name: typeof name === "string" && name ? name.slice(0, 40) : id,
      license: typeof license === "string" ? license.slice(0, 80) : "",
      size: b.size,
      md5: b.md5,
    });
  };
  for (const p of listed) if (p && typeof p.id === "string") add(p.id, p.name, p.license);
  for (const id of bins.sort()) add(id, id, "");
  return out;
}
