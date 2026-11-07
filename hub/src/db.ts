import Database from "better-sqlite3";
import path from "node:path";

export type DB = Database.Database;

export interface UserRow {
  id: number; username: string; display_name: string; pass_hash: string;
  tz: string; tz_auto: number; hook_token: string; hook_token_hash: string; created: number;
}
export interface DeviceRow {
  chip: string; secret_hash: string; owner_id: number | null; name: string | null;
  pair_code: string | null; pair_code_at: number | null; prev_code: string | null; prev_code_until: number | null;
  fw: string | null; ip: string | null; rssi: number | null; heap: number | null; up: number | null;
  last_seen: number | null; last_msg_id: number | null; created: number;
  settings: string | null; place: string | null; reported: string | null; reported_at: number | null;
  ota: string | null; ota_at: number | null; host: string | null; maxblk: number | null; reset: string | null;
  ota_req_at: number | null; ota_from: string | null; wifi: string | null; wifi_at: number | null;
}
export interface FriendRow {
  a: number; b: number; rel: "friend" | null;
  pending_rel: "friend" | null; pending_from: number | null; updated: number;
}
export interface MessageRow {
  id: number; from_id: number; to_id: number; rel: string; kind: "text" | "reaction";
  text: string; reaction: string; t: number;
}

export function openDb(dataDir: string): DB {
  const db = new Database(path.join(dataDir, "hub.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 2000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      tz_auto INTEGER NOT NULL DEFAULT 1,
      hook_token TEXT NOT NULL,
      hook_token_hash TEXT NOT NULL UNIQUE,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      chip TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT,
      pair_code TEXT, pair_code_at INTEGER, prev_code TEXT, prev_code_until INTEGER,
      fw TEXT, ip TEXT, rssi INTEGER, heap INTEGER, up INTEGER,
      last_seen INTEGER, last_msg_id INTEGER,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_owner ON devices(owner_id);
    CREATE TABLE IF NOT EXISTS friends (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rel TEXT, pending_rel TEXT, pending_from INTEGER,
      updated INTEGER NOT NULL,
      PRIMARY KEY (a, b), CHECK (a < b)
    );
    CREATE INDEX IF NOT EXISTS friends_b ON friends(b);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rel TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, reaction TEXT NOT NULL,
      t INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, id);
    CREATE TABLE IF NOT EXISTS apps (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      config TEXT NOT NULL,
      state TEXT,
      updated INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS timers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      ends INTEGER NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS timers_user ON timers(user_id);
    CREATE TABLE IF NOT EXISTS claude_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      sessions TEXT NOT NULL,
      view TEXT
    );
  `);
  // additive migrations
  const cols = new Set((db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [["settings", "TEXT"], ["place", "TEXT"], ["reported", "TEXT"], ["reported_at", "INTEGER"],
    ["ota", "TEXT"], ["ota_at", "INTEGER"], ["host", "TEXT"], ["maxblk", "INTEGER"], ["reset", "TEXT"],
    ["ota_req_at", "INTEGER"], ["ota_from", "TEXT"], ["wifi", "TEXT"], ["wifi_at", "INTEGER"]]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE devices ADD COLUMN ${col} ${type}`);
  }
  db.exec(`
    UPDATE friends SET rel = 'friend' WHERE rel IS NOT NULL AND rel != 'friend';
    UPDATE friends SET pending_rel = NULL, pending_from = NULL WHERE rel IS NOT NULL AND pending_rel IS NOT NULL;
    UPDATE friends SET pending_rel = 'friend' WHERE rel IS NULL AND pending_rel IS NOT NULL AND pending_rel != 'friend';
    UPDATE messages SET rel = 'friend' WHERE rel != 'friend';
  `);
  return db;
}

export function kvGet(db: DB, k: string): string | null {
  const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return r ? r.v : null;
}
export function kvSet(db: DB, k: string, v: string) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}
