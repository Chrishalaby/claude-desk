import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DB, UserRow } from "./db.js";
import { CHIP_RE } from "./broker.js";
import type { Apps } from "./apps.js";
import type { Doodles } from "./doodles.js";
import { HttpError, type Service } from "./service.js";
import { firmwareInfo, PACK_ID_RE, readBlob } from "./files.js";
import { charLen, hashPassword, isValidTz, oneLine, randomHex, RateLimiter, safeEqual, sha256, trunc, verifyPassword } from "./util.js";

const COOKIE = "cd_sid";
const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

declare module "fastify" {
  interface FastifyRequest { user?: UserRow }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function registerRoutes(app: FastifyInstance, svc: Service, db: DB, cfg: Config, apps: Apps, doodles: Doodles) {
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

  const deviceView = (d: ReturnType<Service["device"]> & {}) => svc.deviceView(d);
  const cmdUser = new RateLimiter(10, 60_000, nowMs);
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

  // remote settings (PROTOCOL.md section 8)
  app.get("/api/devices/:chip/settings", { preHandler: auth }, async (req) =>
    svc.settingsView(req.user!.id, (req.params as { chip: string }).chip, requestUrl(req)));

  app.put("/api/devices/:chip/settings", { preHandler: auth }, async (req) => {
    const { chip } = req.params as { chip: string };
    const b = req.body;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "bad_request");
    hubUrl(req);
    const set = svc.putSettings(req.user!.id, chip, b as Record<string, unknown>);
    return { set, ...svc.settingsView(req.user!.id, chip, requestUrl(req)) };
  });

  // commands (PROTOCOL.md section 10)
  for (const cmd of ["ota", "reboot"] as const) {
    app.post(`/api/devices/:chip/${cmd}`, { preHandler: auth }, async (req) => {
      if (!cmdUser.take(String(req.user!.id))) throw new HttpError(429, "rate_limited");
      return { ok: true, sent: svc.command(req.user!.id, (req.params as { chip: string }).chip, cmd, requestUrl(req)) };
    });
  }

  // ---------------------------------------------------------------- firmware + packs (files in the repo)
  app.get("/firmware/latest.json", async (req, reply) => {
    const fw = svc.firmware(requestUrl(req));
    reply.header("cache-control", "no-cache");
    if (!fw) return reply.code(404).send({ error: "no_firmware" });
    return fw;
  });
  const FIRMWARE_FILES = new Set(["claude-desk.bin", "claude-desk.bin.gz", "claude-desk-loader.bin"]);
  app.get("/firmware/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!FIRMWARE_FILES.has(file)) return reply.code(404).send({ error: "not_found" });
    const blob = file === "claude-desk.bin" ? firmwareInfo(cfg.firmwareDir)?.blob : readBlob(path.join(cfg.firmwareDir, file));
    if (!blob) return reply.code(404).send({ error: "no_firmware" });
    const etag = `"${blob.md5}"`;
    reply.header("cache-control", "no-cache").header("etag", etag).header("x-MD5", blob.md5)
      .header("content-disposition", `attachment; filename="${file}"`);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type("application/octet-stream").send(blob.body);
  });
  app.get("/packs/index.json", async (_req, reply) => {
    reply.header("cache-control", "no-cache");
    return { packs: svc.packs() };
  });
  app.get("/packs/:file", async (req, reply) => {
    const m = /^([a-z0-9_-]{1,32})\.(bin|png)$/.exec((req.params as { file: string }).file);
    if (!m || !PACK_ID_RE.test(m[1])) return reply.code(404).send({ error: "not_found" });
    const blob = readBlob(path.join(cfg.packsDir, `${m[1]}.${m[2]}`));
    if (!blob) return reply.code(404).send({ error: "not_found" });
    const etag = `"${blob.md5}"`;
    reply.header("etag", etag).header("cache-control", "public, max-age=3600");
    if (m[2] === "bin") reply.header("x-MD5", blob.md5);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type(m[2] === "png" ? "image/png" : "application/octet-stream").send(blob.body);
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

  const computerUser = new RateLimiter(60, 60_000, nowMs);
  const computerReport = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hookIp.take(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const h = req.headers.authorization ?? "";
    const u = svc.userByHookToken(h.startsWith("Bearer ") ? h.slice(7).trim() : "");
    if (!u) return reply.code(401).send({ error: "token" });
    if (!computerUser.take(String(u.id))) return reply.code(429).send({ error: "rate_limited" });
    const b = req.body;
    return apps.reportComputer(u.id, b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {});
  };
  app.post("/api/computer", { bodyLimit: 16384 }, computerReport);
  app.post("/api/nowplaying", { bodyLimit: 16384 }, computerReport);

  const notifyIp = new RateLimiter(120, 60_000, nowMs);
  const appsUser = new RateLimiter(30, 60_000, nowMs);
  const feedUser = new RateLimiter(10, 600_000, nowMs);
  const notify = async (req: FastifyRequest, reply: FastifyReply, token: string) => {
    if (!notifyIp.take(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const u = svc.userByHookToken(token);
    if (!u) return reply.code(401).send({ error: "token" });
    const b = req.body;
    const card = typeof b === "string" ? { text: b } : b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    const q = req.query as Record<string, unknown>;
    for (const k of ["title", "text", "icon", "color", "secs"]) if (card[k] === undefined && typeof q[k] === "string") card[k] = q[k];
    if (!str(card.title).trim() && !str(card.text).trim() && typeof card.text !== "number") return reply.code(400).send({ error: "empty" });
    const r = svc.sendCard(u.id, { src: card.src ?? "Webhook", ...card });
    if (r.limited) return reply.code(429).send({ error: "rate_limited" });
    return { ok: true, devices: r.devices };
  };
  app.post("/api/notify", { bodyLimit: 4096 }, async (req, reply) => {
    const h = req.headers.authorization ?? "";
    return notify(req, reply, h.startsWith("Bearer ") ? h.slice(7).trim() : "");
  });
  app.post("/api/notify/:token", { bodyLimit: 4096 }, async (req, reply) => notify(req, reply, (req.params as { token: string }).token));

  const appsLimit = async (req: FastifyRequest) => {
    await auth(req);
    if (req.method !== "GET" && !appsUser.take(String(req.user!.id))) throw new HttpError(429, "rate_limited");
  };
  app.get("/api/apps", { preHandler: appsLimit }, async (req) => apps.view(req.user!.id, hubUrl(req)));
  app.post("/api/apps/test", { preHandler: appsLimit }, async (req) => {
    const r = svc.sendCard(req.user!.id, { src: "claude-desk", title: "It works!", text: "This is how notifications look on your desk.", icon: "wave", color: "teal" });
    if (r.limited) throw new HttpError(429, "rate_limited");
    return { ok: true, devices: r.devices };
  });
  app.get("/api/timers", { preHandler: appsLimit }, async (req) => apps.listTimers(req.user!.id));
  app.post("/api/timers", { preHandler: appsLimit }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return apps.addTimer(req.user!.id, b.minutes, b.label);
  });
  app.delete("/api/timers/:id", { preHandler: appsLimit }, async (req) => {
    apps.cancelTimer(req.user!.id, Number((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/apps/calendar/feeds", { preHandler: appsLimit }, async (req) => {
    if (!feedUser.take(String(req.user!.id))) throw new HttpError(429, "rate_limited");
    await apps.addFeed(req.user!.id, ((req.body ?? {}) as Record<string, unknown>).url);
    return apps.view(req.user!.id, hubUrl(req)).calendar;
  });
  app.delete("/api/apps/calendar/feeds/:i", { preHandler: appsLimit }, async (req) => {
    apps.removeFeed(req.user!.id, Number((req.params as { i: string }).i));
    return apps.view(req.user!.id, hubUrl(req)).calendar;
  });
  app.patch("/api/apps/calendar", { preHandler: appsLimit }, async (req) => {
    apps.setCalendarOptions(req.user!.id, (req.body ?? {}) as Record<string, unknown>);
    return apps.view(req.user!.id, hubUrl(req)).calendar;
  });
  app.put("/api/apps/github", { preHandler: appsLimit }, async (req) => {
    await apps.connectGithub(req.user!.id, ((req.body ?? {}) as Record<string, unknown>).token);
    return apps.view(req.user!.id, hubUrl(req)).github;
  });
  app.patch("/api/apps/github", { preHandler: appsLimit }, async (req) => {
    apps.setGithubReasons(req.user!.id, ((req.body ?? {}) as Record<string, unknown>).reasons);
    return apps.view(req.user!.id, hubUrl(req)).github;
  });
  app.delete("/api/apps/github", { preHandler: appsLimit }, async (req) => {
    apps.disconnectGithub(req.user!.id);
    return { ok: true };
  });
  app.put("/api/apps/stocks", { preHandler: appsLimit }, async (req) => {
    apps.setStocks(req.user!.id, ((req.body ?? {}) as Record<string, unknown>).items);
    return apps.view(req.user!.id, hubUrl(req)).stocks;
  });

  const oauthKind = (req: FastifyRequest) => {
    const k = (req.params as { kind: string }).kind;
    if (k !== "spotify" && k !== "slack" && k !== "lastfm") throw new HttpError(404, "not_found");
    return k;
  };
  const oauthRedirect = (req: FastifyRequest, kind: string) => `${hubUrl(req)}/api/apps/${kind}/callback`;
  app.get("/api/apps/:kind/connect", { preHandler: auth }, async (req, reply) => {
    const kind = oauthKind(req);
    try { return reply.redirect(apps.oauthStart(req.user!.id, kind, oauthRedirect(req, kind))); }
    catch (e) { if (e instanceof HttpError) return reply.redirect(`/#/apps?err=${e.code}`); throw e; }
  });
  app.get("/api/apps/:kind/callback", async (req, reply) => {
    const kind = oauthKind(req);
    const u = sessionUser(req);
    if (!u) return reply.redirect("/#/login");
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.error || !q.code || !q.state) return reply.redirect(`/#/apps?err=${kind}_denied`);
    try {
      if (kind === "spotify") await apps.spotifyCallback(u.id, q.code, q.state, oauthRedirect(req, kind));
      else await apps.slackCallback(u.id, q.code, q.state, oauthRedirect(req, kind));
      return reply.redirect(`/#/apps?ok=${kind}`);
    } catch (e) {
      return reply.redirect(`/#/apps?err=${e instanceof HttpError ? e.code : kind + "_failed"}`);
    }
  });
  app.get("/api/apps/lastfm/callback/:state", async (req, reply) => {
    const u = sessionUser(req);
    if (!u) return reply.redirect("/#/login");
    const token = str(((req.query ?? {}) as Record<string, unknown>).token);
    if (!token) return reply.redirect("/#/apps?err=lastfm_denied");
    try {
      await apps.lastfmCallback(u.id, token, (req.params as { state: string }).state);
      return reply.redirect("/#/apps?ok=lastfm");
    } catch (e) {
      return reply.redirect(`/#/apps?err=${e instanceof HttpError ? e.code : "lastfm_failed"}`);
    }
  });
  app.put("/api/apps/lastfm", { preHandler: appsLimit }, async (req) => {
    await apps.connectLastfm(req.user!.id, body(req).user);
    return apps.view(req.user!.id, hubUrl(req)).music;
  });
  app.patch("/api/apps/computer", { preHandler: appsLimit }, async (req) => apps.setComputerOptions(req.user!.id, body(req)));
  app.patch("/api/apps/music/:kind", { preHandler: appsLimit }, async (req) => {
    apps.setMusicOptions(req.user!.id, (req.params as { kind: string }).kind, body(req));
    return apps.view(req.user!.id, hubUrl(req)).music;
  });
  app.get("/api/reminders", { preHandler: auth }, async (req) => apps.listReminders(req.user!.id));
  app.post("/api/reminders", { preHandler: appsLimit }, async (req) => apps.addReminder(req.user!.id, body(req)));
  app.delete("/api/reminders/:id", { preHandler: appsLimit }, async (req) => {
    apps.removeReminder(req.user!.id, Number((req.params as { id: string }).id));
    return { ok: true };
  });
  app.put("/api/apps/rain", { preHandler: appsLimit }, async (req) => {
    apps.setRain(req.user!.id, body(req).on);
    return apps.view(req.user!.id, hubUrl(req)).rain;
  });
  app.put("/api/apps/email", { preHandler: appsLimit }, async (req) => {
    if (!feedUser.take(String(req.user!.id))) throw new HttpError(429, "rate_limited");
    await apps.connectEmail(req.user!.id, body(req));
    return apps.view(req.user!.id, hubUrl(req)).email;
  });
  app.patch("/api/apps/email", { preHandler: appsLimit }, async (req) => {
    apps.setEmailOptions(req.user!.id, body(req));
    return apps.view(req.user!.id, hubUrl(req)).email;
  });
  app.delete("/api/apps/:kind", { preHandler: appsLimit }, async (req) => {
    apps.disconnect(req.user!.id, (req.params as { kind: string }).kind);
    return { ok: true };
  });

  const wifiChip = (req: FastifyRequest) => {
    const chip = (req.params as { chip: string }).chip;
    if (!CHIP_RE.test(chip)) throw new HttpError(404, "not_found");
    return chip;
  };
  app.get("/api/devices/:chip/wifi", { preHandler: auth }, async (req) =>
    svc.wifiView(svc.ownedDevice(req.user!.id, wifiChip(req))) ?? { saved: [], current: "", rssi: null, visible: [], scannedAt: null, at: null });
  app.post("/api/devices/:chip/wifi/scan", { preHandler: appsLimit }, async (req) => {
    svc.wifiCommand(req.user!.id, wifiChip(req), "wifi_scan");
    return { ok: true };
  });
  app.post("/api/devices/:chip/wifi", { preHandler: appsLimit }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    svc.wifiCommand(req.user!.id, wifiChip(req), "wifi_add", str(b.ssid), str(b.pass));
    return { ok: true };
  });
  app.post("/api/devices/:chip/wifi/remove", { preHandler: appsLimit }, async (req) => {
    svc.wifiCommand(req.user!.id, wifiChip(req), "wifi_del", str(((req.body ?? {}) as Record<string, unknown>).ssid));
    return { ok: true };
  });

  const doodleId = (req: FastifyRequest) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "not_found");
    return id;
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  app.post("/api/doodles", { preHandler: auth }, async (req) => doodles.start(req.user!.id, str(body(req).to).trim() || null));
  app.get("/api/doodles/active", { preHandler: auth }, async (req) => doodles.active(req.user!.id));
  app.get("/api/doodles/mine", { preHandler: auth }, async (req) => doodles.mine(req.user!.id));
  app.get("/api/doodles/:id", { preHandler: auth }, async (req) => doodles.view(req.user!.id, doodleId(req)));
  app.post("/api/doodles/:id/strokes", { preHandler: auth, bodyLimit: 16384 }, async (req) => {
    doodles.addStrokes(req.user!.id, doodleId(req), body(req).s);
    return { ok: true };
  });
  app.post("/api/doodles/:id/clear", { preHandler: auth }, async (req) => { doodles.clear(req.user!.id, doodleId(req)); return { ok: true }; });
  app.post("/api/doodles/:id/end", { preHandler: auth }, async (req) => {
    doodles.end(req.user!.id, doodleId(req), Number(body(req).secs) || 60);
    return { ok: true };
  });
  app.post("/api/doodles/:id/show", { preHandler: auth }, async (req) => {
    doodles.show(req.user!.id, doodleId(req), Number(body(req).secs) || 60);
    return { ok: true };
  });
  app.delete("/api/doodles/:id", { preHandler: auth }, async (req) => { doodles.remove(req.user!.id, doodleId(req)); return { ok: true }; });
  app.get("/api/doodles/:id/events", { preHandler: auth }, async (req, reply) => {
    const me = req.user!.id, id = doodleId(req);
    const first = doodles.view(me, id);
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsub = doodles.subscribe(me, id, (event, data) => {
      send(event, data);
      if (event === "end") setTimeout(() => reply.raw.end(), 50);
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
    });
    send("init", first);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 20000);
    req.raw.on("close", () => { clearInterval(ping); unsub(); });
  });

  // ---------------------------------------------------------------- friends
  app.get("/api/friends", { preHandler: auth }, async (req) => svc.listFriends(req.user!.id).map((f) => {
    const id = f.rel ? svc.userByName(f.username)?.id : undefined;
    return { ...f, presence: id ? apps.presence(id) : null };
  }));

  app.post("/api/friends", { preHandler: auth }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return svc.requestFriend(req.user!.id, str(b.username).trim().slice(0, 40));
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
  app.get("/client/agent.py", serveClient("agent.py", false));
  app.get("/client/agent.ps1", serveClient("agent.ps1", false));
  app.get("/client/calendar.swift", serveClient("calendar.swift", false));

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
