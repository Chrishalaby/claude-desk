import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DB, UserRow } from "./db.js";
import { CHIP_RE } from "./broker.js";
import { HttpError, type Rel, type Service } from "./service.js";
import { charLen, hashPassword, isValidTz, oneLine, randomHex, RateLimiter, safeEqual, sha256, trunc, verifyPassword } from "./util.js";

const COOKIE = "cd_sid";
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

declare module "fastify" {
  interface FastifyRequest { user?: UserRow }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function registerRoutes(app: FastifyInstance, svc: Service, db: DB, cfg: Config) {
  const nowMs = () => cfg.now() * 1000;
  const loginIp = new RateLimiter(20, 60_000, nowMs);
  const loginUser = new RateLimiter(10, 60_000, nowMs);
  const registerIp = new RateLimiter(10, 3_600_000, nowMs);
  const helloIp = new RateLimiter(30, 60_000, nowMs);
  const pairUser = new RateLimiter(10, 600_000, nowMs);
  const hookIp = new RateLimiter(1200, 60_000, nowMs);
  const now = () => Math.floor(cfg.now());
  const dummyHash = hashPassword(randomHex(16));

  /** Base URL as seen by this request (behind Railway's proxy: https + public host). */
  const requestUrl = (req: FastifyRequest) => {
    const host = /^[a-z0-9.\-:[\]]+$/i.test(req.host ?? "") ? req.host : "localhost";
    return `${req.protocol}://${host}`;
  };
  const hubUrl = (req: FastifyRequest) => svc.hubUrl(requestUrl(req));

  // ---------------------------------------------------------------- sessions
  function startSession(reply: FastifyReply, req: FastifyRequest, userId: number) {
    const sid = randomHex(32);
    db.prepare("INSERT INTO sessions (id_hash, user_id, expires) VALUES (?, ?, ?)").run(sha256(sid), userId, now() + SESSION_DAYS * 86400);
    reply.setCookie(COOKIE, sid, {
      signed: true, httpOnly: true, sameSite: "lax", path: "/", secure: req.protocol === "https", maxAge: SESSION_DAYS * 86400,
    });
  }

  function sessionUser(req: FastifyRequest): UserRow | undefined {
    const raw = req.cookies[COOKIE];
    if (!raw) return undefined;
    const un = req.unsignCookie(raw);
    if (!un.valid || !un.value) return undefined;
    const row = db.prepare("SELECT user_id FROM sessions WHERE id_hash = ? AND expires > ?").get(sha256(un.value), now()) as
      { user_id: number } | undefined;
    return row ? svc.userById(row.user_id) : undefined;
  }

  const auth = async (req: FastifyRequest) => {
    const u = sessionUser(req);
    if (!u) throw new HttpError(401, "auth");
    req.user = u;
  };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    if (err.validation || err.statusCode === 400 || err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(err.statusCode ?? 400).send({ error: "bad_request" });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "bad_request" });
    app.log.error(err);
    reply.code(500).send({ error: "internal" });
  });

  const me = (u: UserRow, req: FastifyRequest) => ({
    username: u.username, displayName: u.display_name, tz: u.tz, tzAuto: !!u.tz_auto, hub: hubUrl(req),
  });

  // ---------------------------------------------------------------- accounts
  app.get("/api/config", async (req) => ({ inviteRequired: !!cfg.inviteCode, hub: hubUrl(req) }));

  app.post("/api/register", async (req, reply) => {
    if (!registerIp.take(req.ip)) throw new HttpError(429, "rate_limited");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username).trim().toLowerCase();
    const password = str(b.password);
    const displayName = trunc(oneLine(b.displayName), 20) || username;
    if (cfg.inviteCode && !safeEqual(str(b.invite).trim(), cfg.inviteCode)) throw new HttpError(403, "invite");
    if (!USERNAME_RE.test(username)) throw new HttpError(400, "username");
    if (password.length < 8 || password.length > 200) throw new HttpError(400, "password");
    if (svc.userByName(username)) throw new HttpError(409, "taken");
    const tz = isValidTz(b.tz) ? b.tz : "UTC";
    const { token, hash } = svc.newHookToken();
    const info = db.prepare(`INSERT INTO users (username, display_name, pass_hash, tz, tz_auto, hook_token, hook_token_hash, created)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(username, displayName, await hashPassword(password), tz, token, hash, now());
    startSession(reply, req, Number(info.lastInsertRowid));
    return me(svc.userById(Number(info.lastInsertRowid))!, req);
  });

  app.post("/api/login", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username).trim().toLowerCase().slice(0, 40);
    if (!loginIp.take(req.ip) || !loginUser.take(username)) throw new HttpError(429, "rate_limited");
    const u = svc.userByName(username);
    const password = str(b.password).slice(0, 200);
    // always run scrypt so timing doesn't reveal whether the user exists
    const ok = await verifyPassword(password, u?.pass_hash ?? (await dummyHash));
    if (!u || !ok) throw new HttpError(401, "credentials");
    if (u.tz_auto && isValidTz(b.tz) && b.tz !== u.tz) svc.setTimezone(u.id, b.tz, true);
    startSession(reply, req, u.id);
    return me(svc.userById(u.id)!, req);
  });

  app.post("/api/logout", async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const un = raw ? req.unsignCookie(raw) : null;
    if (un?.valid && un.value) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(un.value));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: auth }, async (req) => ({ ...me(req.user!, req), claude: svc.claudeView(req.user!.id) }));

  app.patch("/api/me", { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const u = req.user!;
    if (b.displayName !== undefined) {
      const name = trunc(oneLine(b.displayName), 20);
      if (!name) throw new HttpError(400, "displayName");
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, u.id);
    }
    if (b.tz !== undefined) {
      if (!isValidTz(b.tz)) throw new HttpError(400, "tz");
      svc.setTimezone(u.id, b.tz, false);
    }
    return me(svc.userById(u.id)!, req);
  });

  app.get("/api/token", { preHandler: auth }, async (req) => ({ token: req.user!.hook_token, hub: hubUrl(req) }));
  app.post("/api/token/regenerate", { preHandler: auth }, async (req) => ({ token: svc.regenerateHookToken(req.user!.id), hub: hubUrl(req) }));

  // ---------------------------------------------------------------- devices
  app.post("/api/device/hello", async (req, reply) => {
    if (!helloIp.take(req.ip)) throw new HttpError(429, "rate_limited");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const chip = str(b.chip).toLowerCase();
    if (!CHIP_RE.test(chip)) throw new HttpError(400, "chip");
    const fw = trunc(oneLine(b.fw), 16);
    const secret = str(b.secret).slice(0, 128);
    reply.header("cache-control", "no-store");
    return svc.hello(chip, fw, secret, requestUrl(req));
  });

  const deviceView = (d: ReturnType<Service["device"]> & {}) => ({
    chip: d.chip, name: d.name, fw: d.fw, ip: d.ip, rssi: d.rssi, heap: d.heap, up: d.up,
    lastSeen: d.last_seen, online: svc.broker?.isOnline(d.chip) ?? false,
  });
  const deviceName = (v: unknown) => {
    const n = trunc(oneLine(v), 20);
    return n || "Desk";
  };

  app.get("/api/devices", { preHandler: auth }, async (req) => svc.devicesOf(req.user!.id).map(deviceView));

  app.post("/api/devices/pair", { preHandler: auth }, async (req) => {
    if (!pairUser.take(String(req.user!.id))) throw new HttpError(429, "rate_limited");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const code = str(b.code).replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, "code");
    return deviceView(svc.pair(req.user!.id, code, deviceName(b.name)));
  });

  app.patch("/api/devices/:chip", { preHandler: auth }, async (req) => {
    const { chip } = req.params as { chip: string };
    svc.rename(req.user!.id, chip, deviceName((req.body as any)?.name));
    return deviceView(svc.device(chip)!);
  });

  app.delete("/api/devices/:chip", { preHandler: auth }, async (req) => {
    svc.forget(req.user!.id, (req.params as { chip: string }).chip);
    return { ok: true };
  });

  // ---------------------------------------------------------------- hook
  app.post("/api/hook", { bodyLimit: 8192 }, async (req, reply) => {
    if (!hookIp.take(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const u = svc.userByHookToken(token);
    if (!u) return reply.code(401).send({ error: "token" });
    if (!svc.hookAllowed(u.id)) return reply.code(429).send({ error: "rate_limited" });
    const b = req.body;
    if (b && typeof b === "object" && !Array.isArray(b)) svc.hookEvent(u, b as Record<string, unknown>);
    return { ok: true };
  });

  // ---------------------------------------------------------------- friends
  app.get("/api/friends", { preHandler: auth }, async (req) => svc.listFriends(req.user!.id));

  app.post("/api/friends", { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rel = b.rel === undefined ? "friend" : b.rel;
    if (rel !== "friend" && rel !== "partner") throw new HttpError(400, "rel");
    return svc.requestFriend(req.user!.id, str(b.username).trim().slice(0, 40), rel as Rel);
  });

  app.post("/api/friends/:username/accept", { preHandler: auth }, async (req) =>
    svc.acceptFriend(req.user!.id, (req.params as any).username));
  app.post("/api/friends/:username/decline", { preHandler: auth }, async (req) => {
    svc.declineFriend(req.user!.id, (req.params as any).username);
    return { ok: true };
  });
  app.delete("/api/friends/:username", { preHandler: auth }, async (req) => {
    svc.removeFriend(req.user!.id, (req.params as any).username);
    return { ok: true };
  });

  // ---------------------------------------------------------------- messages
  app.post("/api/messages", { preHandler: auth, bodyLimit: 4096 }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.text === "string" && charLen(b.text) > 1000) throw new HttpError(400, "too_long");
    return svc.sendMessage(req.user!.id, str(b.to).trim(), b.kind, b.text, b.reaction);
  });

  app.get("/api/messages", { preHandler: auth }, async (req) =>
    svc.history(req.user!.id, str((req.query as any)?.with).trim()));

  // ---------------------------------------------------------------- client installers
  const clientDirs = [cfg.clientDir, path.join(cfg.publicDir, "..", "client")];
  const clientFile = (name: string) => {
    for (const d of clientDirs) {
      const p = path.join(d, name);
      try { return fs.readFileSync(p, "utf8"); } catch { /* try next */ }
    }
    return null;
  };
  const serveClient = (name: string, bake: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    let body = clientFile(name);
    if (body === null) return reply.code(404).type("text/plain; charset=utf-8").send("not found\n");
    // Only the first occurrence is the value; later ones are the installer's own "was it baked?" guard.
    if (bake) body = body.replace("__HUB_URL__", () => hubUrl(req));
    return reply.type("text/plain; charset=utf-8").header("cache-control", "no-cache").send(body);
  };
  app.get("/install.sh", serveClient("install.sh", true));
  app.get("/install.ps1", serveClient("install.ps1", true));
  app.get("/client/hook.py", serveClient("hook.py", false));
  app.get("/client/hook.ps1", serveClient("hook.ps1", false));

  // ---------------------------------------------------------------- web app
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon",
  };
  const files = new Map<string, { type: string; body: Buffer }>();
  try {
    for (const f of fs.readdirSync(cfg.publicDir)) {
      const ext = path.extname(f);
      if (types[ext]) files.set("/" + f, { type: types[ext], body: fs.readFileSync(path.join(cfg.publicDir, f)) });
    }
  } catch { /* no public dir */ }
  const sendFile = (name: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
    const f = files.get(name);
    if (!f) return reply.code(404).send({ error: "not_found" });
    return reply.type(f.type).header("cache-control", name === "/index.html" ? "no-cache" : "public, max-age=300").send(f.body);
  };
  for (const name of files.keys()) app.get(name, sendFile(name));
  app.get("/", sendFile("/index.html"));
  app.get("/healthz", async () => ({ ok: true }));
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && req.headers.accept?.includes("text/html")) {
      return sendFile("/index.html")(req, reply);
    }
    reply.code(404).send({ error: "not_found" });
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    return payload;
  });
}
