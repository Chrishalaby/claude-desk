// End-to-end test: real hub (HTTP + MQTT/TLS) on random ports, fake clock, mqtt.js as the device.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { startHub } from "../dist/hub.js";
import { configFromEnv } from "../dist/config.js";
import { deskHostBase } from "../dist/service.js";
import { eventsFromIcs, slackText } from "../dist/apps.js";
import { chunkStrokes, validStrokes } from "../dist/doodles.js";
import { isPrivateAddress } from "../dist/net.js";
import http from "node:http";
import zlib from "node:zlib";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-hub-"));
const fwDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-fw-"));
const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-packs-"));
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const FW_BIN = crypto.randomBytes(50_000);
fs.writeFileSync(path.join(fwDir, "claude-desk.bin"), FW_BIN);
fs.writeFileSync(path.join(fwDir, "version.txt"), "1.4.0\n");
const FW_GZ = Buffer.concat([Buffer.from("1f8b08", "hex"), crypto.randomBytes(30_000)]);
const FW_LOADER = crypto.randomBytes(20_000);
fs.writeFileSync(path.join(fwDir, "claude-desk.bin.gz"), FW_GZ);
fs.writeFileSync(path.join(fwDir, "claude-desk-loader.bin"), FW_LOADER);
const PACK_BIN = Buffer.concat([Buffer.from("CDPK\x01\x00\x00\x00", "latin1"), crypto.randomBytes(1000)]);
const PACK_PNG = Buffer.from("89504e470d0a1a0a", "hex");
fs.writeFileSync(path.join(packsDir, "testpack.bin"), PACK_BIN);
fs.writeFileSync(path.join(packsDir, "testpack.png"), PACK_PNG);
fs.writeFileSync(path.join(packsDir, "index.json"), JSON.stringify({ packs: [
  { id: "testpack", name: "Test Pack", license: "MIT", size: 1, md5: "stale" },
  { id: "ghost", name: "No file", license: "", size: 1, md5: "x" },
] }));
let clock = Math.floor(Date.now() / 1000);

const GH_TOKEN = "ghp_" + "a".repeat(36);
const GH_LAST_MODIFIED = "Sat, 07 Nov 2026 10:00:00 GMT";
let fxPrice = 240, fxGhUpdated = 0, fxPlaying = null, fxSlackTs = "0", fxGoogleRevoked = null, fxGoogleToken = null;
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => r(b)); });
const icsTime = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const icsFor = (now) => ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:standup", `DTSTART:${icsTime(now + 300)}`, `DTEND:${icsTime(now + 1200)}`, "SUMMARY:Standup", "LOCATION:Room 4", "END:VEVENT",
  "BEGIN:VEVENT", "UID:later", `DTSTART:${icsTime(now + 3 * 3600)}`, `DTEND:${icsTime(now + 4 * 3600)}`, "SUMMARY:Later thing", "END:VEVENT",
  "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261107", "SUMMARY:Holiday", "END:VEVENT",
  "END:VCALENDAR"].join("\r\n");
const fixtures = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://fixtures");
  const json = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (u.pathname === "/sa/api/token") {
    const f = new URLSearchParams(await readBody(req));
    if (f.get("client_id") !== "spotify-test") return json(400, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code" && f.get("code") === "blocked") return json(200, { access_token: "acc-blocked", refresh_token: "refb", expires_in: 3600 });
    if (f.get("grant_type") === "authorization_code") return f.get("code") === "good" && f.get("code_verifier")?.length >= 43
      ? json(200, { access_token: "acc1", refresh_token: "ref1", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
    if (f.get("grant_type") === "refresh_token") return json(200, { access_token: "acc2", expires_in: 3600 });
    return json(400, {});
  }
  if (u.pathname === "/sp/v1/me") return req.headers.authorization === "Bearer acc-blocked"
    ? json(403, { error: { status: 403, message: "Check settings on developer.spotify.com/dashboard, the user may not be registered." } })
    : json(200, { display_name: "Erin S" });
  if (u.pathname === "/sp/v1/me/player/currently-playing") {
    if (!/^Bearer acc/.test(req.headers.authorization ?? "")) return json(401, {});
    if (!fxPlaying) { res.statusCode = 204; return res.end(); }
    return json(200, { is_playing: true, item: { name: fxPlaying, artists: [{ name: "The Weeknd" }] } });
  }
  if (u.pathname === "/lf/2.0/") {
    if (u.searchParams.get("api_key") !== "lastfm-test") return json(403, { error: 10 });
    if (u.searchParams.get("user") === "nobody") return json(200, { error: 6, message: "User not found" });
    if (u.searchParams.get("method") === "auth.getSession") {
      const t = u.searchParams.get("token");
      const sig = md5(`api_keylastfm-testmethodauth.getSessiontoken${t}lastfm-secret`);
      return t === "good-token-1" && u.searchParams.get("api_sig") === sig
        ? json(200, { session: { name: "erin_listens", key: "sk1", subscriber: 0 } }) : json(403, { error: 4, message: "Invalid token" });
    }
    if (u.searchParams.get("method") === "user.getinfo") return json(200, { user: { name: u.searchParams.get("user") } });
    return json(200, { recenttracks: { track: [{ name: "Ocean Eyes", artist: { "#text": "Billie Eilish" }, "@attr": { nowplaying: "true" } }] } });
  }
  if (u.pathname === "/go/token") {
    const f = new URLSearchParams(await readBody(req));
    if (f.get("client_id") !== "google-test" || f.get("client_secret") !== "google-secret") return json(401, { error: "invalid_client" });
    const idToken = ["x", Buffer.from(JSON.stringify({ email: "erin@example.com" })).toString("base64url"), "sig"].join(".");
    const cal = "https://www.googleapis.com/auth/calendar.readonly";
    if (f.get("grant_type") === "authorization_code" && f.get("code_verifier")?.length >= 43) {
      if (f.get("code") === "good") return json(200, { access_token: "gacc1", refresh_token: "gref1", expires_in: 3600, id_token: idToken, scope: `openid ${cal} https://www.googleapis.com/auth/userinfo.email` });
      if (f.get("code") === "noscope") return json(200, { access_token: "gacc0", refresh_token: "gref0", expires_in: 3600, id_token: idToken, scope: "openid email" });
    }
    if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "gref1") return json(200, { access_token: "gacc2", expires_in: 3600 });
    return json(400, { error: "invalid_grant" });
  }
  if (u.pathname === "/go/revoke") { fxGoogleRevoked = new URLSearchParams(await readBody(req)).get("token"); return json(200, {}); }
  if (u.pathname.startsWith("/gapi/calendar/v3/")) {
    if (!/^Bearer gacc[12]$/.test(req.headers.authorization ?? "")) return json(401, {});
    fxGoogleToken = req.headers.authorization.slice(7);
    if (u.pathname === "/gapi/calendar/v3/users/me/calendarList") return json(200, { items: [{ id: "erin@example.com", selected: true }, { id: "en.holidays#holiday@group.v.calendar.google.com", selected: false }, { id: "team@group.calendar.google.com", selected: true }] });
    const cal = decodeURIComponent(u.pathname.split("/")[5]);
    if (u.searchParams.get("singleEvents") !== "true" || !u.searchParams.get("timeMin")) return json(400, {});
    const at = (t) => ({ dateTime: new Date(t * 1000).toISOString() });
    if (cal === "erin@example.com") return json(200, { items: [
      { id: "e1", status: "confirmed", summary: "1:1 with Sam", location: "Zoom", start: at(clock + 1800), end: at(clock + 3600) },
      { id: "e2", status: "confirmed", summary: "Holiday", start: { date: "2026-11-08" }, end: { date: "2026-11-09" } },
      { id: "e3", status: "confirmed", summary: "Declined thing", start: at(clock + 4000), end: at(clock + 5000), attendees: [{ self: true, responseStatus: "declined" }] },
      { id: "e4", status: "cancelled", summary: "Cancelled", start: at(clock + 4500), end: at(clock + 5000) },
    ] });
    if (cal === "team@group.calendar.google.com") return json(200, { items: [{ id: "t1", status: "confirmed", summary: "Team sync", start: at(clock + 7200), end: at(clock + 9000) }] });
    return json(404, {});
  }
  if (u.pathname === "/w/v1/forecast") {
    const slot = Math.floor(clock / 900) * 900;
    const time = Array.from({ length: 8 }, (_, i) => new Date((slot + i * 900) * 1000).toISOString().slice(0, 16));
    return json(200, { minutely_15: { time, precipitation: [0, 0, 0.6, 0.8, 0.4, 0, 0, 0] } });
  }
  if (u.pathname === "/sl/oauth.v2.access") {
    const f = new URLSearchParams(await readBody(req));
    return f.get("code") === "good" && f.get("client_secret") === "slack-secret"
      ? json(200, { ok: true, authed_user: { id: "U1", access_token: "xoxp-1" }, team: { name: "Acme" } }) : json(200, { ok: false, error: "invalid_code" });
  }
  if (u.pathname === "/sl/search.messages") {
    if (req.headers.authorization !== "Bearer xoxp-1") return json(200, { ok: false, error: "invalid_auth" });
    return json(200, { ok: true, messages: { matches: [
      { ts: fxSlackTs, user: "U2", username: "sam", channel: { name: "general" }, text: "hey <@U1|erin> can you look at <https://x.io/pr|the PR>?" },
      { ts: fxSlackTs, user: "U1", username: "erin", channel: { name: "general" }, text: "my own message" },
    ] } });
  }
  if (u.pathname === "/cal.ics") { res.setHeader("content-type", "text/calendar"); return res.end(icsFor(clock)); }
  if (u.pathname === "/not-ics") return res.end("hello");
  if (u.pathname === "/gh/user") return req.headers.authorization === `Bearer ${GH_TOKEN}` ? json(200, { login: "dora-gh" }) : json(401, {});
  if (u.pathname === "/gh/notifications") {
    if (req.headers["if-modified-since"] === GH_LAST_MODIFIED) { res.statusCode = 304; return res.end(); }
    res.setHeader("last-modified", GH_LAST_MODIFIED);
    res.setHeader("x-poll-interval", "60");
    const at = new Date(fxGhUpdated * 1000).toISOString();
    return json(200, [
      { id: "1", reason: "review_requested", updated_at: at, subject: { title: "Add calendar" }, repository: { full_name: "dora/desk" } },
      { id: "2", reason: "subscribed", updated_at: at, subject: { title: "Noise" }, repository: { full_name: "dora/desk" } },
    ]);
  }
  if (u.pathname.startsWith("/q/v8/finance/chart/")) {
    const sym = decodeURIComponent(u.pathname.split("/").pop());
    if (sym !== "AAPL") return json(404, {});
    return json(200, { chart: { result: [{ meta: { regularMarketPrice: fxPrice, chartPreviousClose: 240, currency: "USD" } }] } });
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => fixtures.listen(0, "127.0.0.1", r));
const fx = `http://127.0.0.1:${fixtures.address().port}`;
const TZ = "Asia/Beirut";
const hhmm = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t * 1000));

function makeConfig() {
  return {
    ...configFromEnv({}),
    dataDir, httpHost: "127.0.0.1", httpPort: 0, mqttPort: 0,
    publicUrl: null, mqttPublicHost: null, mqttPublicPort: null,
    inviteCode: "letmein", sessionSecret: null, tlsCert: null, tlsKey: null,
    clientDir: path.join(here, "..", "..", "client"),
    firmwareDir: fwDir, packsDir,
    githubApi: fx + "/gh", quotesApi: fx + "/q", allowPrivateFetch: true, weatherApi: fx + "/w",
    spotifyClientId: "spotify-test", spotifyAccounts: fx + "/sa", spotifyApi: fx + "/sp", lastfmKey: "lastfm-test", lastfmSecret: "lastfm-secret", lastfmApi: fx + "/lf", lastfmAuth: fx + "/lfauth/",
    slackClientId: "slack-test", slackClientSecret: "slack-secret", slackApi: fx + "/sl", googleClientId: "google-test", googleClientSecret: "google-secret", googleAccounts: fx + "/ga", googleOAuth: fx + "/go", googleApi: fx + "/gapi",
    now: () => clock, log: false,
  };
}

let hub;
let base;
const clients = [];

async function startIt() {
  hub = await startHub(makeConfig());
  base = `http://127.0.0.1:${hub.httpPort}`;
}

// ---------------------------------------------------------------- http helpers
function user() {
  const jar = {};
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(Object.keys(jar).length ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return { call, jar, cookie };
}
const anon = user();

// ---------------------------------------------------------------- mqtt helpers
async function device(chip, secret, opts = {}) {
  const c = await mqtt.connectAsync(`mqtts://127.0.0.1:${hub.mqttPort}`, {
    clientId: chip, username: chip, password: secret, keepalive: 60, clean: true,
    rejectUnauthorized: false, reconnectPeriod: 0, connectTimeout: 5000, ...opts,
  });
  clients.push(c);
  const got = [];
  c.on("message", (topic, payload, packet) => {
    assert.ok(payload.length <= 768, `payload on ${topic} is ${payload.length} bytes`);
    let json = null;
    try { json = payload.length ? JSON.parse(payload.toString()) : null; } catch { json = null; }
    got.push({ topic, raw: payload.toString(), buf: Buffer.from(payload), json, retain: packet.retain });
  });
  c.got = got;
  c.waitFor = async (pred, what = "message", ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = got.find((x) => !x.seen && pred(x));
      if (m) { for (const x of got.slice(0, got.indexOf(m) + 1)) x.seen = true; return m; }
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}; got ${JSON.stringify(got.filter((x) => !x.seen).map((x) => [x.topic, x.raw]))}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  c.latest = (topic) => [...got].reverse().find((x) => x.topic === topic);
  c.quiet = async (ms = 150) => { await new Promise((r) => setTimeout(r, ms)); };
  return c;
}

/** Subscribes and returns the granted QoS (128 = refused). */
async function sub(c, topic, qos = 1) {
  try { return (await c.subscribeAsync(topic, { qos }))[0].qos; }
  catch (e) { if (e.packet?.granted) return e.packet.granted[0]; throw e; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(startIt);
after(async () => {
  for (const c of clients) c.end(true);
  await hub?.close();
  fixtures.close();
  for (const d of [dataDir, fwDir, packsDir]) fs.rmSync(d, { recursive: true, force: true });
});

// shared state across sequential tests
const alice = user(), bob = user(), carol = user();
const devA = { chip: "esp-00a1b2" }, devB = { chip: "esp-0b0b0b" };

test("accounts: invite code, registration, login, timezone", async () => {
  const cfg = await anon.call("GET", "/api/config");
  assert.equal(cfg.body.inviteRequired, true);
  let r = await alice.call("POST", "/api/register", { username: "alice", password: "password-a", invite: "nope" });
  assert.equal(r.status, 403);
  r = await alice.call("POST", "/api/register", { username: "Alice", displayName: "Alice", password: "password-a", invite: "letmein", tz: TZ });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.username, "alice");
  assert.equal(r.body.tz, TZ);
  r = await bob.call("POST", "/api/register", { username: "bob", displayName: "Bob", password: "password-b", invite: "letmein" });
  assert.equal(r.status, 200);
  r = await carol.call("POST", "/api/register", { username: "carol", displayName: "Carol", password: "password-c", invite: "letmein" });
  assert.equal(r.status, 200);
  r = await anon.call("POST", "/api/register", { username: "bob", password: "password-x", invite: "letmein" });
  assert.equal(r.status, 409);
  r = await anon.call("POST", "/api/register", { username: "x!", password: "password-x", invite: "letmein" });
  assert.equal(r.status, 400);

  r = await anon.call("POST", "/api/login", { username: "bob", password: "wrong-pass" });
  assert.equal(r.status, 401);
  // login with a browser timezone updates an auto-detected tz
  const bob2 = user();
  r = await bob2.call("POST", "/api/login", { username: "bob", password: "password-b", tz: "Europe/Paris" });
  assert.equal(r.status, 200);
  assert.equal(r.body.tz, "Europe/Paris");
  r = await bob2.call("POST", "/api/logout");
  assert.equal((await bob2.call("GET", "/api/me")).status, 401);
  assert.equal((await bob.call("GET", "/api/me")).status, 200);
  assert.equal((await anon.call("GET", "/api/me")).status, 401);

  r = await bob.call("PATCH", "/api/me", { displayName: "Bobby", tz: "Not/AZone" });
  assert.equal(r.status, 400);
  r = await bob.call("PATCH", "/api/me", { displayName: "Bobby" });
  assert.equal(r.body.displayName, "Bobby");
});

test("friends: request, accept, mutual request connects, decline, one friend type", async () => {
  let r = await alice.call("POST", "/api/friends", { username: "bob" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.rel, r.body.pendingRel, r.body.pendingFrom], [null, "friend", "me"]);
  r = await bob.call("GET", "/api/friends");
  assert.deepEqual(r.body.map((f) => [f.username, f.pendingRel, f.pendingFrom]), [["alice", "friend", "them"]]);
  // the requester can't accept their own request
  assert.equal((await alice.call("POST", "/api/friends/bob/accept")).status, 404);
  r = await bob.call("POST", "/api/friends/alice/accept");
  assert.equal(r.status, 200);
  assert.equal(r.body.rel, "friend");

  await carol.call("POST", "/api/friends", { username: "alice", rel: "partner" });
  r = await alice.call("POST", "/api/friends", { username: "carol" });
  assert.deepEqual([r.body.rel, r.body.pendingRel], ["friend", null]);
  r = await carol.call("POST", "/api/friends", { username: "alice" });
  assert.deepEqual([r.body.rel, r.body.pendingRel], ["friend", null]);
  r = await alice.call("GET", "/api/friends");
  assert.deepEqual(r.body.map((f) => [f.username, f.rel, f.pendingRel]), [["bob", "friend", null], ["carol", "friend", null]]);

  assert.equal((await alice.call("POST", "/api/friends", { username: "alice" })).status, 400);
  assert.equal((await alice.call("POST", "/api/friends", { username: "nobody" })).status, 404);
});

test("TLS: TLS 1.2 ECDHE-RSA-AES128-GCM-SHA256, RSA-2048, fingerprint + pubkey match hello", async () => {
  const r = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.0", secret: "" });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.secret, /^[0-9a-f]{40}$/);
  assert.equal(r.body.paired, false);
  assert.match(r.body.pairCode, /^\d{6}$/);
  assert.equal(r.body.owner, null);
  assert.equal(r.body.mqtt.tls, true);
  assert.equal(r.body.mqtt.port, hub.mqttPort);
  assert.match(r.body.mqtt.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(r.body.mqtt.pubkey, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n$/);
  assert.ok(Buffer.byteLength(r.text) < 1024, `hello response is ${r.text.length} bytes`);
  console.log(`# hello response: ${Buffer.byteLength(r.text)} bytes`);
  devA.secret = r.body.secret;
  devA.code = r.body.pairCode;
  devA.mqtt = r.body.mqtt;

  const info = await new Promise((resolve, reject) => {
    const s = tls.connect({
      host: "127.0.0.1", port: hub.mqttPort, rejectUnauthorized: false,
      maxVersion: "TLSv1.2", minVersion: "TLSv1.2", ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
    }, () => {
      const cert = s.getPeerCertificate();
      resolve({ cipher: s.getCipher(), proto: s.getProtocol(), fp: cert.fingerprint256, bits: cert.bits, raw: cert.raw });
      s.end();
    });
    s.on("error", reject);
  });
  assert.equal(info.proto, "TLSv1.2");
  assert.equal(info.cipher.name, "ECDHE-RSA-AES128-GCM-SHA256");
  assert.equal(info.bits, 2048);
  assert.equal(info.fp, devA.mqtt.fingerprint);
  const x = new crypto.X509Certificate(info.raw);
  assert.equal(x.publicKey.export({ type: "spki", format: "pem" }), devA.mqtt.pubkey);

  // a full-default client (TLS 1.2 offer with many suites) still gets the GCM suite first
  const pref = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: hub.mqttPort, rejectUnauthorized: false, maxVersion: "TLSv1.2" },
      () => { resolve(s.getCipher().name); s.end(); });
    s.on("error", reject);
  });
  assert.equal(pref, "ECDHE-RSA-AES128-GCM-SHA256");
});

test("device hello rules + pairing over MQTT cfg", async () => {
  let r = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.0", secret: "" });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: "secret" });
  r = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.0", secret: "f".repeat(40) });
  assert.equal(r.status, 403);
  r = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.1", secret: devA.secret });
  assert.equal(r.status, 200);
  assert.equal(r.body.secret, undefined);
  assert.equal(r.body.pairCode, devA.code, "code is stable within 10 min");
  assert.equal((await anon.call("POST", "/api/device/hello", { chip: "ESP-zz", secret: "" })).status, 400);

  // wrong MQTT password is refused
  await assert.rejects(device(devA.chip, "0".repeat(40)));
  // username must equal chip
  await assert.rejects(device(devA.chip, devA.secret, { username: "esp-ffffff" }));

  const a = await device(devA.chip, devA.secret);
  assert.equal(a.stream.getPeerCertificate().fingerprint256, devA.mqtt.fingerprint);
  devA.client = a;
  await a.subscribeAsync(`desk/${devA.chip}/#`, { qos: 1 });
  let cfg = await a.waitFor((m) => m.topic === `desk/${devA.chip}/cfg`, "unpaired cfg");
  assert.equal(cfg.retain, true);
  assert.deepEqual(cfg.json, { paired: false, pairCode: devA.code, hub: base });

  // wrong code
  const wrong = devA.code === "000000" ? "000001" : "000000";
  assert.equal((await alice.call("POST", "/api/devices/pair", { code: wrong, name: "Desk" })).status, 404);
  r = await alice.call("POST", "/api/devices/pair", { code: devA.code, name: "Desk" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.chip, devA.chip);
  cfg = await a.waitFor((m) => m.topic === `desk/${devA.chip}/cfg` && m.json.paired, "paired cfg");
  assert.deepEqual(cfg.json, { paired: true, owner: "alice", name: "Desk", host: "alice-desk", hub: base });
  const claude = await a.waitFor((m) => m.topic === `desk/${devA.chip}/claude`, "initial claude");
  assert.equal(claude.json.s, "idle");

  r = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.1", secret: devA.secret });
  assert.deepEqual([r.body.paired, r.body.owner, r.body.pairCode], [true, "alice", undefined]);

  // second device (bob): code rotates every 10 min and the new code is published on cfg
  r = await anon.call("POST", "/api/device/hello", { chip: devB.chip, fw: "1.3.0", secret: "" });
  devB.secret = r.body.secret;
  const b = await device(devB.chip, devB.secret);
  devB.client = b;
  await b.subscribeAsync(`desk/${devB.chip}/#`, { qos: 1 });
  const first = await b.waitFor((m) => m.topic === `desk/${devB.chip}/cfg`, "bob cfg");
  assert.equal(first.json.pairCode, r.body.pairCode);
  clock += 601;
  hub.tick();
  const rotated = await b.waitFor((m) => m.topic === `desk/${devB.chip}/cfg` && m.json.pairCode !== first.json.pairCode, "rotated code");
  assert.match(rotated.json.pairCode, /^\d{6}$/);
  assert.equal(rotated.json.paired, false);
  clock += 120; // old code's grace period is over
  hub.tick();
  assert.equal((await bob.call("POST", "/api/devices/pair", { code: first.json.pairCode, name: "Bob desk" })).status, 404);
  r = await bob.call("POST", "/api/devices/pair", { code: rotated.json.pairCode, name: "Bob desk" });
  assert.equal(r.status, 200);
  await b.waitFor((m) => m.topic === `desk/${devB.chip}/cfg` && m.json.paired && m.json.owner === "bob", "bob paired");

  // rename republishes cfg
  r = await bob.call("PATCH", `/api/devices/${devB.chip}`, { name: "Kitchen" });
  assert.equal(r.body.name, "Kitchen");
  await b.waitFor((m) => m.topic === `desk/${devB.chip}/cfg` && m.json.name === "Kitchen", "renamed cfg");
  // other users can't touch it
  assert.equal((await alice.call("PATCH", `/api/devices/${devB.chip}`, { name: "x" })).status, 404);
  assert.equal((await alice.call("DELETE", `/api/devices/${devB.chip}`)).status, 404);
});

test("ACL: own namespace only; status is stored", async () => {
  const a = devA.client;
  assert.equal(await sub(a, `desk/${devB.chip}/#`), 128);
  assert.equal(await sub(a, `desk/${devB.chip}/claude`), 128);
  assert.equal(await sub(a, "#"), 128);
  assert.equal(await sub(a, "desk/+/msg"), 128);
  assert.equal(await sub(a, "$SYS/#"), 128);
  assert.equal(await sub(a, `desk/${devA.chip}/msg`), 1);

  await a.publishAsync(`desk/${devA.chip}/up/status`, JSON.stringify({ fw: "1.3.2", ip: "192.168.1.107", rssi: -40, heap: 23000, maxblk: 15000, reset: "Exception", up: 3600 }), { qos: 1 });
  await sleep(100);
  assert.equal(a.got.filter((m) => m.topic.includes("/up/")).length, 0, "up/ messages are not echoed to the device");
  const r = await alice.call("GET", "/api/devices");
  assert.equal(r.body.length, 1);
  assert.deepEqual([r.body[0].fw, r.body[0].ip, r.body[0].rssi, r.body[0].online], ["1.3.2", "192.168.1.107", -40, true]);
  assert.deepEqual([r.body[0].heap, r.body[0].maxblk, r.body[0].reset], [23000, 15000, "Exception"]);

  // a device that publishes outside desk/<own>/up/# is disconnected, and nothing reaches the victim
  const before = devB.client.got.length;
  const rogue = await device(devA.chip, devA.secret); // replaces devA's connection (same client id)
  const closed = new Promise((res) => rogue.once("close", res));
  rogue.publish(`desk/${devB.chip}/msg`, JSON.stringify({ id: 999999, text: "spoof" }));
  await closed;
  await sleep(100);
  assert.equal(devB.client.got.slice(before).filter((m) => m.raw.includes("spoof")).length, 0);
  // device can't fake its own claude topic either
  const a2 = await device(devA.chip, devA.secret);
  const closed2 = new Promise((res) => a2.once("close", res));
  a2.publish(`desk/${devA.chip}/claude`, JSON.stringify({ s: "needs" }));
  await closed2;

  // reconnect devA for the rest of the tests
  devA.client = await device(devA.chip, devA.secret);
  await devA.client.subscribeAsync(`desk/${devA.chip}/#`, { qos: 1 });
  await devA.client.waitFor((m) => m.topic === `desk/${devA.chip}/claude`, "claude after reconnect");
});

test("hook: needs -> working -> done -> idle, parallel PostToolUse keeps a pending permission", async () => {
  const a = devA.client;
  const tok = (await alice.call("GET", "/api/token")).body.token;
  assert.match(tok, /^[0-9a-f]{64}$/);
  const hook = (ev, token = tok) => anon.call("POST", "/api/hook", ev, { authorization: `Bearer ${token}` });
  const claude = (pred, what) => a.waitFor((m) => m.topic === `desk/${devA.chip}/claude` && pred(m.json), what);

  assert.equal((await hook({ e: "Stop", sid: "x" }, "nope")).status, 401);
  assert.equal((await anon.call("POST", "/api/hook", { e: "Stop" })).status, 401);

  let r = await hook({ e: "UserPromptSubmit", sid: "s1", project: "supy-api" });
  assert.deepEqual(r.body, { ok: true });
  let v = await claude((j) => j.s === "working", "working");
  assert.deepEqual([v.json.p, v.json.d, v.json.f], ["", "", ""]);

  clock += 5;
  const t1 = clock;
  await hook({ e: "PermissionRequest", sid: "s1", project: "supy-api", tool: "Bash", detail: "npm test", tid: "toolu_1" });
  v = await claude((j) => j.s === "needs", "needs");
  assert.deepEqual(v.json, { s: "needs", p: "supy-api", d: "Allow Bash: npm test", f: hhmm(t1), t: t1 });

  // parallel tool in the same session finishes: still needs
  clock += 1;
  await hook({ e: "PostToolUse", sid: "s1", project: "supy-api", tool: "Read", detail: "app.ts", tid: "toolu_2" });
  hub.tick();
  await a.quiet();
  assert.equal(a.latest(`desk/${devA.chip}/claude`).json.s, "needs");
  assert.equal(hub.service.claudeView(1).d, "Allow Bash: npm test");

  // a permission-type notification while something is pending does nothing
  await hook({ e: "Notification", sid: "s1", project: "supy-api", ntype: "permission_prompt", msg: "Claude needs your permission to use Bash" });
  assert.equal(hub.service.claudeView(1).d, "Allow Bash: npm test");

  // a second session asks too (no tid): newest wins, footer counts the others
  clock += 2;
  const t2 = clock;
  await hook({ e: "PermissionRequest", sid: "s2", project: "website", tool: "Write", detail: "index.md" });
  v = await claude((j) => j.s === "needs" && j.p === "website", "second needs");
  assert.deepEqual(v.json, { s: "needs", p: "website", d: "Allow Write: index.md", f: `+1 more waiting · ${hhmm(t2)}`, t: t2 });
  // its PostToolUse matches by tool:detail
  await hook({ e: "PostToolUse", sid: "s2", project: "website", tool: "Write", detail: "index.md" });
  v = await claude((j) => j.s === "needs" && j.p === "supy-api", "back to first needs");
  assert.equal(v.json.f, hhmm(t1));
  await hook({ e: "SessionEnd", sid: "s2", project: "website" });

  // the permitted tool finishes -> working
  clock += 3;
  await hook({ e: "PostToolUse", sid: "s1", project: "supy-api", tool: "Bash", detail: "npm test", tid: "toolu_1" });
  v = await claude((j) => j.s === "working", "working again");

  clock += 10;
  const t3 = clock;
  await hook({ e: "Stop", sid: "s1", project: "supy-api" });
  v = await claude((j) => j.s === "done", "done");
  assert.deepEqual(v.json, { s: "done", p: "supy-api", d: "Finished", f: hhmm(t3), t: t3 });

  clock += 5;
  hub.tick();
  await a.quiet();
  assert.equal(a.latest(`desk/${devA.chip}/claude`).json.s, "done", "done holds for 10 s");
  clock += 6;
  hub.tick();
  v = await claude((j) => j.s === "idle", "idle after done");

  // generic (notification) needs, cleared by the next PostToolUse
  await hook({ e: "UserPromptSubmit", sid: "s3", project: "cortex" });
  await claude((j) => j.s === "working", "working s3");
  await hook({ e: "Notification", sid: "s3", project: "cortex", ntype: "", msg: "Claude needs your permission to use WebFetch" });
  v = await claude((j) => j.s === "needs", "generic needs");
  assert.equal(v.json.d, "Claude needs your permission to use WebFetch");
  // an idle_prompt notification is not a "needs"
  await hook({ e: "Notification", sid: "s3", project: "cortex", ntype: "idle_prompt", msg: "Claude is waiting for your input" });
  assert.equal(hub.service.claudeView(1).d, "Claude needs your permission to use WebFetch");
  await hook({ e: "PostToolUse", sid: "s3", project: "cortex", tool: "WebFetch", detail: "https://example.com", tid: "toolu_9" });
  await claude((j) => j.s === "working", "working after generic cleared");

  // working expires after 15 min without activity
  clock += 15 * 60 + 1;
  hub.tick();
  await claude((j) => j.s === "idle", "idle after working ttl");

  // long fields are truncated to the device limits
  await hook({ e: "PermissionRequest", sid: "s4", project: "p".repeat(80), tool: "Bash", detail: "x".repeat(200) });
  v = await claude((j) => j.s === "needs", "long needs");
  assert.ok([...v.json.p].length <= 32 && [...v.json.d].length <= 80 && [...v.json.f].length <= 40);
  await hook({ e: "SessionEnd", sid: "s4" });
  await claude((j) => j.s === "idle", "idle after session end");

  // regenerate: old token stops working
  const nt = (await alice.call("POST", "/api/token/regenerate")).body.token;
  assert.notEqual(nt, tok);
  assert.equal((await hook({ e: "Stop", sid: "z" })).status, 401);
  assert.equal((await hook({ e: "Stop", sid: "z" }, nt)).status, 200);
  await claude((j) => j.s === "done", "done with new token");
  clock += 11;
  hub.tick();
  await claude((j) => j.s === "idle", "idle");
});

test("messages: text + reactions, retained delivery, every reaction for friends, limits, history", async () => {
  const b = devB.client;
  let r = await alice.call("POST", "/api/messages", { to: "bob", kind: "text", text: "see you at 8?" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.devices, 1);
  const id1 = r.body.message.id;
  let m = await b.waitFor((x) => x.topic === `desk/${devB.chip}/msg`, "text msg");
  assert.deepEqual(m.json, { id: id1, from: "alice", name: "Alice", rel: "friend", kind: "text", text: "see you at 8?", reaction: "", t: clock });

  r = await alice.call("POST", "/api/messages", { to: "bob", kind: "reaction", reaction: "heart" });
  assert.equal(r.status, 200);
  m = await b.waitFor((x) => x.topic === `desk/${devB.chip}/msg`, "heart");
  assert.equal(m.json.reaction, "heart");
  assert.equal(m.json.kind, "reaction");
  assert.ok(m.json.id > id1, "ids strictly increase");

  // a fresh connection gets the latest message as retained
  const b2 = await device(devB.chip, devB.secret);
  await b2.subscribeAsync(`desk/${devB.chip}/msg`, { qos: 1 });
  m = await b2.waitFor((x) => x.topic === `desk/${devB.chip}/msg`, "retained msg");
  assert.equal(m.retain, true);
  assert.equal(m.json.reaction, "heart");
  devB.client = b2;

  r = await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "heart" });
  assert.equal(r.status, 200, r.text);
  m = await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/msg` && x.json.reaction === "heart", "heart to alice");
  assert.deepEqual([m.json.from, m.json.name, m.json.rel, m.json.reaction], ["carol", "Carol", "friend", "heart"]);
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "eggplant" })).body.error, "bad_reaction");
  clock += 61;
  r = await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "wave" });
  assert.equal(r.status, 200);
  m = await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/msg` && x.json.reaction === "wave", "wave to alice");
  assert.deepEqual([m.json.from, m.json.name, m.json.rel, m.json.reaction], ["carol", "Carol", "friend", "wave"]);

  // validation
  assert.equal((await carol.call("POST", "/api/messages", { to: "bob", kind: "text", text: "hi" })).body.error, "not_friends");
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "text", text: "x".repeat(101) })).status, 400);
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "text", text: "😀".repeat(100) })).status, 200);
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "text", text: "   " })).status, 400);
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "poop" })).status, 400);
  m = await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/msg` && x.json.text.startsWith("😀"), "emoji text");
  assert.ok(Buffer.byteLength(m.raw) <= 768);

  // rate limit: 10/min per sender (carol has sent 2 accepted messages)
  let last;
  for (let i = 0; i < 9; i++) last = await carol.call("POST", "/api/messages", { to: "alice", kind: "text", text: `n${i}` });
  assert.equal(last.status, 429);
  clock += 61;
  assert.equal((await carol.call("POST", "/api/messages", { to: "alice", kind: "text", text: "ok again" })).status, 200);

  // history: newest first, both directions
  await bob.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "kiss" });
  r = await alice.call("GET", "/api/messages?with=bob");
  assert.deepEqual(r.body.map((x) => [x.from, x.kind, x.mine]), [["bob", "reaction", false], ["alice", "reaction", true], ["alice", "text", true]]);
  r = await bob.call("GET", "/api/messages?with=alice");
  assert.equal(r.body[0].mine, true);
});

test("remote settings: PUT -> retained set with increasing rev, up/settings reported", async () => {
  const a = devA.client;
  const url = `/api/devices/${devA.chip}/settings`;
  let r = await alice.call("GET", url);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.settings, null);
  assert.deepEqual(r.body.packs.map((p) => [p.id, p.name, p.md5, p.size]), [["testpack", "Test Pack", md5(PACK_BIN), PACK_BIN.length]]);
  assert.equal(r.body.firmware.version, "1.4.0");

  r = await alice.call("PUT", url, { layout: 0, soft: 1, casper: 0, pack: "testpack", bday: 60, bnight: 5, nstart: 23, nend: 6,
    lat: 45.76123456, lon: 4.83, place: "Lyon, France" });
  assert.equal(r.status, 200, r.text);
  let m = await a.waitFor((x) => x.topic === `desk/${devA.chip}/set`, "set");
  const rev1 = m.json.rev;
  assert.ok(rev1 >= clock);
  assert.deepEqual(m.json, { rev: rev1, layout: 0, soft: 1, casper: 0, pack: "testpack", bday: 60, bnight: 5, nstart: 23, nend: 6,
    lat: 45.7612, lon: 4.83, packUrl: `${base}/packs/testpack.bin`, packMd5: md5(PACK_BIN) });
  assert.equal(m.json.place, undefined, "place stays on the hub");

  // partial update, same second: rev still increases, other keys kept, pixel has no packUrl
  r = await alice.call("PUT", url, { bday: 70, pack: "pixel" });
  m = await a.waitFor((x) => x.topic === `desk/${devA.chip}/set`, "set 2");
  assert.ok(m.json.rev > rev1);
  assert.deepEqual([m.json.bday, m.json.layout, m.json.pack, m.json.packUrl, m.json.lat], [70, 0, "pixel", undefined, 45.7612]);
  devA.rev = m.json.rev;

  for (const bad of [{ bday: 101 }, { nstart: 24 }, { layout: "x" }, { pack: "nope" }, { lat: 95, lon: 0 }, { lat: 1 }, {}]) {
    assert.equal((await alice.call("PUT", url, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await bob.call("PUT", url, { bday: 1 })).status, 404);
  assert.equal((await bob.call("GET", url)).status, 404);

  // the desk reports what it runs
  await a.publishAsync(`desk/${devA.chip}/up/settings`, JSON.stringify({ rev: devA.rev, layout: 0, soft: 1, casper: 0, pack: "pixel",
    bday: 70, bnight: 5, nstart: 23, nend: 6, lat: 45.7612, lon: 4.83, packs: ["pixel", "testpack"], junk: "x".repeat(50) }), { qos: 1 });
  await sleep(100);
  r = await alice.call("GET", url);
  assert.equal(r.body.place, "Lyon, France");
  assert.equal(r.body.settings.rev, devA.rev);
  assert.deepEqual(r.body.reported.packs, ["pixel", "testpack"]);
  assert.equal(r.body.reported.rev, devA.rev);
  assert.equal(r.body.reported.junk, undefined);
  assert.ok(r.body.reportedAt);
  assert.equal(r.body.device.online, true);
});

test("firmware + packs served; ota/reboot cmd only to the owner's device", async () => {
  let r = await anon.call("GET", "/firmware/latest.json");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { version: "1.4.0", url: `${base}/firmware/claude-desk.bin`, md5: md5(FW_BIN), size: FW_BIN.length });
  let res = await fetch(base + "/firmware/claude-desk.bin");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-md5"), md5(FW_BIN));
  assert.equal(md5(Buffer.from(await res.arrayBuffer())), md5(FW_BIN));
  for (const [file, body] of [["claude-desk.bin.gz", FW_GZ], ["claude-desk-loader.bin", FW_LOADER]]) {
    res = await fetch(base + "/firmware/" + file);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${file}"`);
    assert.equal(res.headers.get("content-encoding"), null, "served as a plain file, never re-encoded");
    assert.equal(md5(Buffer.from(await res.arrayBuffer())), md5(body));
  }
  assert.equal((await fetch(base + "/firmware/version.txt")).status, 404);
  assert.equal((await fetch(base + "/firmware/..%2Fhub.db")).status, 404);

  r = await anon.call("GET", "/packs/index.json");
  assert.deepEqual(r.body, { packs: [{ id: "testpack", name: "Test Pack", license: "MIT", size: PACK_BIN.length, md5: md5(PACK_BIN) }] });
  res = await fetch(base + "/packs/testpack.bin");
  assert.equal(res.status, 200);
  assert.equal(md5(Buffer.from(await res.arrayBuffer())), md5(PACK_BIN));
  res = await fetch(base + "/packs/testpack.png");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal((await fetch(base + "/packs/ghost.bin")).status, 404);
  assert.equal((await fetch(base + "/packs/..%2Findex.bin")).status, 404);

  // the committed packs in hub/packs (if generated) match their index
  const real = path.join(here, "..", "packs");
  if (fs.existsSync(path.join(real, "index.json"))) {
    for (const p of JSON.parse(fs.readFileSync(path.join(real, "index.json"), "utf8")).packs) {
      const b = fs.readFileSync(path.join(real, p.id + ".bin"));
      assert.deepEqual([p.id, b.length, md5(b)], [p.id, p.size, p.md5]);
      assert.equal(b.subarray(0, 4).toString(), "CDPK");
    }
  }

  // ota: not for other people's desks; delivered (not retained) to the owner's desk only
  const bBefore = devB.client.got.length;
  assert.equal((await bob.call("POST", `/api/devices/${devA.chip}/ota`)).status, 404);
  r = await alice.call("POST", `/api/devices/${devA.chip}/ota`);
  assert.equal(r.status, 200, r.text);
  const m = await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/cmd`, "ota cmd");
  assert.deepEqual(m.json, { cmd: "ota", url: `${base}/firmware/claude-desk.bin`, md5: md5(FW_BIN), version: "1.4.0" });
  assert.equal(m.retain, false);
  r = await alice.call("GET", `/api/devices/${devA.chip}/settings`);
  assert.equal(r.body.device.otaPending, true);
  r = await alice.call("POST", `/api/devices/${devA.chip}/ota`);
  assert.deepEqual([r.status, r.body.error], [409, "busy"], "no second update while one is running");
  r = await alice.call("POST", `/api/devices/${devA.chip}/reboot`);
  assert.deepEqual([r.status, r.body.error], [409, "busy"], "no restart in the middle of an update");
  const fwBefore = (await alice.call("GET", `/api/devices/${devA.chip}/settings`)).body.device.fw;
  await devA.client.publishAsync(`desk/${devA.chip}/up/status`, JSON.stringify({ fw: "1.4.0", ip: "192.168.1.107" }), { qos: 1 });
  await sleep(100);
  r = await alice.call("GET", `/api/devices/${devA.chip}/settings`);
  assert.deepEqual([r.body.device.otaPending, r.body.device.fw, r.body.device.ota], [false, "1.4.0", `ok: ${fwBefore} → 1.4.0`]);
  r = await alice.call("POST", `/api/devices/${devA.chip}/ota`);
  assert.equal(r.status, 200);
  await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/cmd` && x.json.cmd === "ota", "second ota cmd");
  await devA.client.publishAsync(`desk/${devA.chip}/up/status`, JSON.stringify({ fw: "1.4.0", ota: "failed: HTTP error: connection failed" }), { qos: 1 });
  await sleep(100);
  r = await alice.call("GET", `/api/devices/${devA.chip}/settings`);
  assert.deepEqual([r.body.device.otaPending, r.body.device.ota], [false, "failed: HTTP error: connection failed"]);
  clock += 1;
  r = await alice.call("POST", `/api/devices/${devA.chip}/ota`);
  assert.equal(r.status, 200);
  await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/cmd` && x.json.cmd === "ota", "third ota cmd");
  clock += 301;
  assert.equal((await alice.call("GET", `/api/devices/${devA.chip}/settings`)).body.device.otaPending, false, "a lost update stops blocking after 5 min");
  r = await alice.call("POST", `/api/devices/${devA.chip}/reboot`);
  assert.deepEqual((await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/cmd`, "reboot cmd")).json, { cmd: "reboot" });
  await sleep(100);
  assert.equal(devB.client.got.slice(bBefore).filter((x) => x.topic.endsWith("/cmd")).length, 0);
  // a fresh connection doesn't get an old command
  const probe = await device(devB.chip, devB.secret);
  await probe.subscribeAsync(`desk/${devB.chip}/#`, { qos: 1 });
  await probe.quiet(200);
  assert.equal(probe.got.filter((x) => x.topic.endsWith("/cmd")).length, 0);
  devB.client = probe;

  // result comes back on up/status
  await devA.client.publishAsync(`desk/${devA.chip}/up/status`, JSON.stringify({ fw: "1.4.0", ip: "192.168.1.107", ota: "ok" }), { qos: 1 });
  await sleep(100);
  r = await alice.call("GET", `/api/devices/${devA.chip}/settings`);
  assert.deepEqual([r.body.device.ota, r.body.device.fw], ["ok", "1.4.0"]);

  // offline desk -> 409
  devB.client.end(true);
  await sleep(100);
  assert.equal((await bob.call("POST", `/api/devices/${devB.chip}/reboot`)).status, 409);
});

test("hub restart keeps retained cfg/claude/msg, cert and sessions", async () => {
  const fp = hub.tls.fingerprint;
  const tok = (await alice.call("GET", "/api/token")).body.token;
  // leave alice in "needs" so we can see it survive
  await anon.call("POST", "/api/hook", { e: "PermissionRequest", sid: "r1", project: "restart", tool: "Bash", detail: "ls" }, { authorization: `Bearer ${tok}` });
  for (const c of clients.splice(0)) c.end(true);
  await hub.close();
  await startIt();
  assert.equal(hub.tls.fingerprint, fp, "cert persisted");
  assert.equal((await alice.call("GET", "/api/me")).status, 200, "web session persisted");

  const a = await device(devA.chip, devA.secret);
  await a.subscribeAsync(`desk/${devA.chip}/#`, { qos: 1 });
  const cfg = await a.waitFor((m) => m.topic === `desk/${devA.chip}/cfg`, "cfg after restart");
  assert.equal(cfg.json.owner, "alice");
  const cl = await a.waitFor((m) => m.topic === `desk/${devA.chip}/claude`, "claude after restart");
  assert.deepEqual([cl.json.s, cl.json.p, cl.json.d], ["needs", "restart", "Allow Bash: ls"]);
  const msg = await a.waitFor((m) => m.topic === `desk/${devA.chip}/msg`, "msg after restart");
  assert.deepEqual([msg.json.from, msg.json.reaction], ["bob", "kiss"]);
  const set = await a.waitFor((m) => m.topic === `desk/${devA.chip}/set`, "set after restart");
  assert.deepEqual([set.json.rev, set.json.bday], [devA.rev, 70]);
  devA.client = a;
});

test("installers and static files", async () => {
  const sh = await anon.call("GET", "/install.sh");
  const clientExists = fs.existsSync(path.join(here, "..", "..", "client", "install.sh"));
  if (clientExists) {
    // the first __HUB_URL__ (the default value) is baked; the installer's guard keeps the placeholder
    const baked = (text, file) => {
      const raw = fs.readFileSync(path.join(here, "..", "..", "client", file), "utf8");
      assert.equal(text, raw.replace("__HUB_URL__", base));
      assert.ok(text.indexOf(base) < (text.indexOf("__HUB_URL__") >>> 0));
    };
    assert.equal(sh.status, 200);
    baked(sh.text, "install.sh");
    const ps = await anon.call("GET", "/install.ps1");
    assert.equal(ps.status, 200);
    baked(ps.text, "install.ps1");
    assert.equal((await anon.call("GET", "/client/hook.py")).status, 200);
    assert.equal((await anon.call("GET", "/client/hook.ps1")).status, 200);
    for (const f of ["/client/agent.py", "/client/agent.ps1"]) {
      const c = await anon.call("GET", f);
      assert.equal(c.status, 200, f);
      assert.ok(c.text.includes("/api/computer"), f);
    }
    assert.ok((await anon.call("GET", "/client/calendar.swift")).text.includes("EventKit"));
    assert.ok(sh.text.includes("agent.py") && sh.text.includes("calendar.swift") && ps.text.includes("agent.ps1"), "installers set up the computer agent");
  } else {
    assert.equal(sh.status, 404);
  }
  const idx = await anon.call("GET", "/");
  assert.equal(idx.status, 200);
  assert.ok(idx.text.includes("app.js"));
  assert.equal((await anon.call("GET", "/app.js")).status, 200);
  assert.equal((await anon.call("GET", "/api/nope")).status, 404);
});

test("forget device: kicked, retained cleared, next hello re-creates it", async () => {
  const a = devA.client;
  const closed = new Promise((res) => a.once("close", res));
  const r = await alice.call("DELETE", `/api/devices/${devA.chip}`);
  assert.equal(r.status, 200);
  const cfg = await a.waitFor((m) => m.topic === `desk/${devA.chip}/cfg` && m.json.paired === false, "unpaired cfg on forget");
  assert.equal(cfg.json.pairCode, null);
  await closed;
  assert.deepEqual((await alice.call("GET", "/api/devices")).body, []);
  await assert.rejects(device(devA.chip, devA.secret), "old secret no longer accepted");
  const h = await anon.call("POST", "/api/device/hello", { chip: devA.chip, fw: "1.3.2", secret: devA.secret });
  assert.equal(h.status, 200);
  assert.match(h.body.secret, /^[0-9a-f]{40}$/);
  assert.notEqual(h.body.secret, devA.secret);
  assert.equal(h.body.paired, false);
  const a2 = await device(devA.chip, h.body.secret);
  await a2.subscribeAsync(`desk/${devA.chip}/#`, { qos: 1 });
  const c2 = await a2.waitFor((m) => m.topic === `desk/${devA.chip}/cfg`, "new cfg");
  assert.deepEqual(c2.json, { paired: false, pairCode: h.body.pairCode, hub: base });
  await a2.quiet(200);
  assert.equal(a2.got.filter((m) => /\/(claude|msg|set)$/.test(m.topic)).filter((m) => m.raw).length, 0,
    "no stale claude/msg/set for an unpaired device");
});

test("desk hostnames: <username>-desk, then -2, lowest free name reused", async () => {
  assert.equal(deskHostBase("dee_jay"), "dee-jay-desk");
  assert.equal(deskHostBase("_x__y_"), "x-y-desk");
  assert.equal(deskHostBase("___"), "user-desk");
  const pairNew = async (chip) => {
    const h = await anon.call("POST", "/api/device/hello", { chip, fw: "1.4.1", secret: "" });
    assert.equal(h.status, 200, h.text);
    const r = await carol.call("POST", "/api/devices/pair", { code: h.body.pairCode, name: "Desk" });
    assert.equal(r.status, 200, r.text);
    return r.body.host;
  };
  assert.equal(await pairNew("esp-c0ffe1"), "carol-desk");
  assert.equal(await pairNew("esp-c0ffe2"), "carol-desk-2");
  assert.equal((await carol.call("DELETE", "/api/devices/esp-c0ffe1")).status, 200);
  assert.equal(await pairNew("esp-c0ffe3"), "carol-desk");
  assert.deepEqual((await carol.call("GET", "/api/devices")).body.map((d) => d.host).sort(), ["carol-desk", "carol-desk-2"]);
  for (const c of ["esp-c0ffe2", "esp-c0ffe3"]) assert.equal((await carol.call("DELETE", `/api/devices/${c}`)).status, 200);
});

test("broker sends TLS records of at most 2 KB, so devices can use a small receive buffer", async () => {
  const h = await anon.call("POST", "/api/device/hello", { chip: "esp-0dd5e1", fw: "1.4.2", secret: "" });
  assert.equal(h.status, 200, h.text);
  const records = [];
  const proxy = net.createServer((down) => {
    const up = net.connect(hub.mqttPort, "127.0.0.1");
    down.pipe(up);
    let buf = Buffer.alloc(0);
    up.on("data", (d) => {
      down.write(d);
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
        records.push({ type: buf[0], len: buf.readUInt16BE(3) });
        buf = buf.subarray(5 + buf.readUInt16BE(3));
      }
    });
    for (const [a, b] of [[down, up], [up, down]]) { a.on("error", () => b.destroy()); a.on("close", () => b.destroy()); }
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const c = await mqtt.connectAsync(`mqtts://127.0.0.1:${proxy.address().port}`, {
    clientId: "esp-0dd5e1", username: "esp-0dd5e1", password: h.body.secret, clean: true,
    rejectUnauthorized: false, reconnectPeriod: 0, connectTimeout: 5000, maxVersion: "TLSv1.2",
  });
  try {
    await c.subscribeAsync("desk/esp-0dd5e1/#", { qos: 1 });
    const got = new Promise((res) => c.on("message", (topic, payload) => { if (topic.endsWith("/probe")) res(payload); }));
    hub.broker.publish("desk/esp-0dd5e1/probe", { big: "x".repeat(6000) }, false);
    assert.equal(JSON.parse((await got).toString()).big.length, 6000);
    const data = records.filter((r) => r.type === 23);
    assert.ok(records.every((r) => r.len <= 2048 + 64), `record sizes ${records.map((r) => r.len)}`);
    assert.ok(data.filter((r) => r.len > 1500).length >= 3, `6 KB publish split into 2 KB records: ${data.map((r) => r.len)}`);
  } finally {
    c.end(true);
    proxy.close();
  }
});

test("calendar parsing: time zones, daylight saving, repeats, exceptions, all-day", () => {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VTIMEZONE", "TZID:Europe/Athens",
    "BEGIN:STANDARD", "DTSTART:19701025T040000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:19700329T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0300", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:daily", "DTSTART;TZID=Europe/Athens:20261020T100000", "DTEND;TZID=Europe/Athens:20261020T103000",
    "RRULE:FREQ=DAILY", "EXDATE;TZID=Europe/Athens:20261026T100000", "SUMMARY:Standup", "END:VEVENT",
    "BEGIN:VEVENT", "UID:once", "DTSTART:20261024T150000Z", "DTEND:20261024T160000Z", "SUMMARY:Dentist", "END:VEVENT",
    "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261024", "SUMMARY:Holiday", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n");
  const at = (s) => Math.floor(Date.parse(s) / 1000);
  const evs = eventsFromIcs(ics, at("2026-10-24T00:00:00Z"), at("2026-10-27T23:59:00Z"));
  assert.deepEqual(evs.map((e) => [e.title, new Date(e.start * 1000).toISOString()]), [
    ["Standup", "2026-10-24T07:00:00.000Z"],
    ["Dentist", "2026-10-24T15:00:00.000Z"],
    ["Standup", "2026-10-25T08:00:00.000Z"],
    ["Standup", "2026-10-27T08:00:00.000Z"],
  ], "10:00 Athens is 07:00Z before the DST change and 08:00Z after; the 26th is excluded; all-day events are skipped");
  assert.equal(evs[0].end - evs[0].start, 1800);
});

test("private network addresses are refused for user-supplied URLs", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("apps: webhook, timer, calendar, GitHub and markets reach the desk; Wi-Fi is managed through the hub", async () => {
  const dora = user();
  let r = await dora.call("POST", "/api/register", { username: "dora", displayName: "Dora", password: "password-d", invite: "letmein" });
  assert.equal(r.status, 200, r.text);
  const hello = await anon.call("POST", "/api/device/hello", { chip: "esp-d0a001", fw: "1.4.5", secret: "" });
  r = await dora.call("POST", "/api/devices/pair", { code: hello.body.pairCode, name: "Dora" });
  assert.equal(r.status, 200, r.text);
  const d = await device("esp-d0a001", hello.body.secret);
  await d.subscribeAsync("desk/esp-d0a001/#", { qos: 1 });
  const card = (pred, what) => d.waitFor((m) => m.topic === "desk/esp-d0a001/card" && m.json && pred(m.json), what);
  const next = (pred, what) => d.waitFor((m) => m.topic === "desk/esp-d0a001/next" && pred(m), what);
  const cards = (pred) => d.got.filter((m) => m.topic === "desk/esp-d0a001/card" && m.json && pred(m.json)).length;

  const token = (await dora.call("GET", "/api/token")).body.token;
  r = await anon.call("POST", `/api/notify/${token}`, { title: "Build passed", text: "deploy done", icon: "fire", color: "green", secs: 20 });
  assert.deepEqual([r.status, r.body.devices], [200, 1]);
  let m = await card((j) => j.title === "Build passed", "webhook card");
  assert.deepEqual({ ...m.json, id: 0 }, { id: 0, src: "WEBHOOK", title: "Build passed", text: "deploy done", icon: "fire", color: "green", secs: 20 });
  assert.equal(m.retain, false);
  r = await anon.call("POST", "/api/notify", { text: "hello" }, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 200);
  await card((j) => j.text === "hello", "bearer webhook");
  const plain = await fetch(`${base}/api/notify/${token}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "plain text works" });
  assert.equal(plain.status, 200);
  await card((j) => j.text === "plain text works", "text/plain webhook");
  r = await anon.call("POST", `/api/notify/${token}`, { text: "weird", icon: "eggplant", color: "chartreuse", secs: 9999 });
  m = await card((j) => j.text === "weird", "sanitized card");
  assert.deepEqual([m.json.icon, m.json.color, m.json.secs], ["", "teal", 300]);
  assert.equal((await anon.call("POST", "/api/notify/not-a-token", { text: "x" })).status, 401);
  assert.equal((await anon.call("POST", `/api/notify/${token}`, {})).status, 400);

  r = await dora.call("POST", "/api/timers", { minutes: 1, label: "Focus" });
  assert.equal(r.status, 200, r.text);
  let n = await next((x) => x.json?.text === "Focus", "timer next-up");
  assert.deepEqual(n.json, { text: "Focus", at: clock + 60, left: true });
  assert.equal((await dora.call("POST", "/api/timers", { minutes: 0 })).status, 400);
  clock += 61;
  await hub.apps.tick();
  await card((j) => j.src === "TIMER" && j.title === "Focus", "timer done");
  await next((x) => x.raw === "", "next-up cleared");
  assert.deepEqual((await dora.call("GET", "/api/timers")).body, []);

  assert.equal((await dora.call("POST", "/api/apps/calendar/feeds", { url: `${fx}/not-ics` })).body.error, "calendar_not_a_calendar");
  assert.equal((await dora.call("POST", "/api/apps/calendar/feeds", { url: "ftp://example.com/x.ics" })).body.error, "calendar_https_only");
  r = await dora.call("POST", "/api/apps/calendar/feeds", { url: `${fx}/cal.ics` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.feeds[0].ok, true, JSON.stringify(r.body));
  assert.equal(r.body.feeds[0].count, 2, "all-day events are not counted");
  await hub.apps.tick();
  m = await card((j) => j.src === "CALENDAR" && j.title === "Standup", "calendar reminder");
  assert.match(m.json.text, /^in 5 min · \d\d:\d\d · Room 4$/);
  n = await next((x) => x.json?.text === "Standup", "calendar next-up");
  assert.deepEqual(n.json, { text: "Standup", at: clock + 300, left: false });
  await hub.apps.tick();
  await d.quiet(150);
  assert.equal(cards((j) => j.title === "Standup"), 1, "one reminder per event");
  r = await dora.call("PATCH", "/api/apps/calendar", { showNext: false });
  assert.equal(r.body.showNext, false);
  await next((x) => x.raw === "", "next-up off");

  assert.equal((await dora.call("PUT", "/api/apps/github", { token: "ghp_" + "b".repeat(36) })).body.error, "github_token");
  r = await dora.call("PUT", "/api/apps/github", { token: GH_TOKEN });
  assert.deepEqual([r.status, r.body.login, r.body.connected], [200, "dora-gh", true]);
  fxGhUpdated = clock + 30;
  clock += 60;
  await hub.apps.tick();
  m = await card((j) => j.src === "GITHUB", "github card");
  assert.deepEqual([m.json.title, m.json.text, m.json.color], ["Review requested", "dora/desk: Add calendar", "purple"]);
  clock += 61;
  await hub.apps.tick();
  await d.quiet(150);
  assert.equal(cards((j) => j.src === "GITHUB"), 1, "no repeats, other reasons filtered");
  r = await dora.call("GET", "/api/apps");
  assert.ok(!r.text.includes(GH_TOKEN), "the token never leaves the hub");
  assert.equal(r.body.github.login, "dora-gh");
  assert.ok(r.body.webhook.url.endsWith(`/api/notify/${token}`));

  assert.equal((await dora.call("PUT", "/api/apps/stocks", { items: [{ symbol: "bad sym!" }] })).body.error, "symbol");
  r = await dora.call("PUT", "/api/apps/stocks", { items: [{ symbol: "aapl", above: 250, move: 5 }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.items[0].symbol, "AAPL");
  fxPrice = 240;
  await hub.apps.tick();
  await d.quiet(100);
  assert.equal(cards((j) => j.src === "MARKETS"), 0, "first look only records the side");
  fxPrice = 260;
  clock += 301;
  await hub.apps.tick();
  await card((j) => j.src === "MARKETS" && j.text.includes("above 250.00"), "price crossed");
  m = await card((j) => j.src === "MARKETS" && j.text.includes("big move"), "big move");
  assert.equal(m.json.title, "AAPL 260.00");
  assert.match(m.json.text, /^\+8\.33% today/);
  r = await dora.call("GET", "/api/apps");
  assert.deepEqual([r.body.stocks.quotes.AAPL.price, r.body.stocks.quotes.AAPL.pct], [260, 8.33]);

  await d.publishAsync("desk/esp-d0a001/up/wifi", JSON.stringify({ saved: ["Home", "Hotspot"], current: "Hotspot", rssi: -50 }), { qos: 1 });
  await sleep(100);
  r = await dora.call("GET", "/api/devices/esp-d0a001/wifi");
  assert.deepEqual([r.body.saved, r.body.current, r.body.visible], [["Home", "Hotspot"], "Hotspot", []]);
  assert.equal((await dora.call("POST", "/api/devices/esp-d0a001/wifi/scan")).status, 200);
  assert.deepEqual((await d.waitFor((x) => x.topic === "desk/esp-d0a001/cmd" && x.json.cmd === "wifi_scan", "scan cmd")).json, { cmd: "wifi_scan" });
  await d.publishAsync("desk/esp-d0a001/up/wifi", JSON.stringify({ saved: ["Home", "Hotspot"], current: "Hotspot", rssi: -50,
    visible: [{ s: "HomeNet", r: -60, o: 0 }, { s: "Cafe", r: -80, o: 1 }] }), { qos: 1 });
  await sleep(100);
  r = await dora.call("GET", "/api/devices/esp-d0a001/wifi");
  assert.deepEqual(r.body.visible, [{ ssid: "HomeNet", rssi: -60, open: false }, { ssid: "Cafe", rssi: -80, open: true }]);
  assert.equal((await dora.call("POST", "/api/devices/esp-d0a001/wifi", { ssid: "HomeNet", pass: "short" })).body.error, "wifi_pass");
  r = await dora.call("POST", "/api/devices/esp-d0a001/wifi", { ssid: "HomeNet", pass: "correct horse" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await d.waitFor((x) => x.topic === "desk/esp-d0a001/cmd" && x.json.cmd === "wifi_add", "add cmd")).json,
    { cmd: "wifi_add", ssid: "HomeNet", pass: "correct horse" });
  assert.ok(!(await dora.call("GET", "/api/devices/esp-d0a001/wifi")).text.includes("correct horse"), "passwords are not stored");
  r = await dora.call("POST", "/api/devices/esp-d0a001/wifi/remove", { ssid: "Home" });
  assert.deepEqual((await d.waitFor((x) => x.topic === "desk/esp-d0a001/cmd" && x.json.cmd === "wifi_del", "remove cmd")).json, { cmd: "wifi_del", ssid: "Home" });
  assert.equal((await bob.call("GET", "/api/devices/esp-d0a001/wifi")).status, 404);
  assert.equal((await bob.call("POST", "/api/devices/esp-d0a001/wifi/scan")).status, 404);

  await d.publishAsync("desk/esp-d0a001/up/status", JSON.stringify({ fw: "1.4.5", ip: "192.168.1.9" }), { qos: 1 });
  await sleep(100);
  r = await dora.call("POST", "/api/devices/esp-d0a001/ota");
  assert.deepEqual([r.status, r.body.error], [409, "downgrade"], "the hub has 1.4.0, the desk runs 1.4.5");
});

test("drawing data: validation and chunking for the desk's 768-byte messages", () => {
  assert.equal(validStrokes(Buffer.from([0xff, 6, 7, 10, 10, 50, 50])), true);
  assert.equal(validStrokes(Buffer.from([10, 10])), false, "must start with a stroke header");
  assert.equal(validStrokes(Buffer.from([0xff, 12, 7, 10, 10])), false, "unknown colour");
  assert.equal(validStrokes(Buffer.from([0xff, 1, 0, 10, 10])), false, "zero width");
  assert.equal(validStrokes(Buffer.from([0xff, 1, 3, 240, 10])), false, "off the 240x240 canvas");
  assert.equal(validStrokes(Buffer.from([0xff, 1, 3, 10])), false, "half a point");
  const long = [0xff, 3, 5];
  for (let i = 0; i < 900; i++) long.push(i % 240, (i * 7) % 240);
  const parts = chunkStrokes(Buffer.from(long), 700);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.length <= 700, `chunk ${p.length}`);
    assert.equal(p[0], 0xff, "every chunk starts with a stroke header so it draws on its own");
    assert.equal(validStrokes(p), true);
  }
  assert.deepEqual([...parts[1].subarray(3, 5)], [...parts[0].subarray(parts[0].length - 2)], "a continued stroke repeats its last point");
  assert.equal(slackText("hi <@U1|erin>, <!here> see <https://a.b|link> &amp; <#C1|dev>"), "hi @erin, @here see link & #dev");
});

test("shared drawings live on both desks and both browsers; own canvas; music, reminders, rain, Slack, email", async () => {
  const erin = user(), fred = user();
  let r = await erin.call("POST", "/api/register", { username: "erin", displayName: "Erin", password: "password-e", invite: "letmein", tz: "UTC" });
  assert.equal(r.status, 200, r.text);
  r = await fred.call("POST", "/api/register", { username: "fred", displayName: "Fred", password: "password-f", invite: "letmein", tz: "UTC" });
  assert.equal(r.status, 200, r.text);
  await erin.call("POST", "/api/friends", { username: "fred" });
  await fred.call("POST", "/api/friends", { username: "erin" });
  const desk = async (who, chip) => {
    const hl = await anon.call("POST", "/api/device/hello", { chip, fw: "1.4.6", secret: "" });
    assert.equal((await who.call("POST", "/api/devices/pair", { code: hl.body.pairCode, name: "Desk" })).status, 200);
    const c = await device(chip, hl.body.secret);
    await c.subscribeAsync(`desk/${chip}/#`, { qos: 1 });
    return c;
  };
  const de = await desk(erin, "esp-e0e001"), df = await desk(fred, "esp-f0f001");
  const frames = (c, chip, op) => c.got.filter((m) => m.topic === `desk/${chip}/draw` && m.buf[0] === op);
  const waitOp = (c, chip, op, n = 1) => c.waitFor(() => frames(c, chip, op).length >= n, `draw op ${op} on ${chip}`);
  const sse = async (who, id) => {
    const res = await fetch(`${base}/api/doodles/${id}/events`, { headers: { cookie: who.cookie() } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(data) });
        }
      }
    })();
    events.until = async (pred, what) => {
      for (let t = 0; t < 100; t++) { const e = events.find(pred); if (e) return e; await sleep(30); }
      throw new Error("timeout waiting for " + what + " " + JSON.stringify(events.map((e) => e.ev)));
    };
    events.stop = () => reader.cancel().catch(() => {});
    return events;
  };

  assert.equal((await erin.call("POST", "/api/doodles", { to: "alice" })).status, 403, "only friends");
  r = await erin.call("POST", "/api/doodles", { to: "fred" });
  assert.equal(r.status, 200, r.text);
  const id = r.body.id;
  assert.equal((await fred.call("POST", "/api/doodles", { to: "erin" })).body.id, id, "the friend joins the open drawing");
  await waitOp(de, "esp-e0e001", 1);
  await waitOp(df, "esp-f0f001", 1);
  assert.equal(frames(df, "esp-f0f001", 1)[0].buf.subarray(4).toString(), "Erin", "Fred's desk names Erin");
  const live = (await fred.call("GET", "/api/doodles/active")).body;
  assert.deepEqual(live.map((d) => [d.id, d.with, d.startedByMe]), [[id, "erin", false]]);
  const evE = await sse(erin, id);
  await evE.until((e) => e.ev === "init", "init");
  const stroke = Buffer.from([0xff, 6, 7, 10, 10, 50, 50, 90, 30]);
  assert.equal((await fred.call("POST", `/api/doodles/${id}/strokes`, { s: stroke.toString("base64") })).status, 200);
  const got = await evE.until((e) => e.ev === "strokes", "fred's strokes in erin's browser");
  assert.deepEqual([got.data.by, got.data.s], ["fred", stroke.toString("base64")]);
  await waitOp(de, "esp-e0e001", 2);
  await waitOp(df, "esp-f0f001", 2);
  assert.deepEqual([...frames(de, "esp-e0e001", 2)[0].buf.subarray(3)], [...stroke], "binary strokes reach the desk as-is");
  assert.equal((await fred.call("POST", `/api/doodles/${id}/strokes`, { s: Buffer.from([1, 2, 3]).toString("base64") })).body.error, "strokes");
  assert.equal((await anon.call("POST", `/api/doodles/${id}/strokes`, { s: "" })).status, 401);
  assert.equal((await erin.call("POST", `/api/doodles/${id}/clear`)).status, 200);
  await waitOp(df, "esp-f0f001", 4);
  await erin.call("POST", `/api/doodles/${id}/strokes`, { s: stroke.toString("base64") });
  assert.equal((await erin.call("POST", `/api/doodles/${id}/end`, { secs: 120 })).status, 200);
  await evE.until((e) => e.ev === "end", "end");
  evE.stop();
  await waitOp(df, "esp-f0f001", 3);
  const endF = frames(df, "esp-f0f001", 3)[0].buf;
  assert.equal((endF[3] << 8) | endF[4], 120);
  r = await fred.call("GET", "/api/messages?with=erin");
  const dm = r.body.find((m) => m.kind === "doodle");
  assert.ok(dm, "the finished drawing is in the chat");
  assert.equal(dm.doodle, stroke.toString("base64"));
  assert.deepEqual((await fred.call("GET", "/api/doodles/active")).body, []);

  r = await erin.call("POST", "/api/doodles", {});
  const own = r.body.id;
  const before = df.got.length;
  await erin.call("POST", `/api/doodles/${own}/strokes`, { s: stroke.toString("base64") });
  await erin.call("POST", `/api/doodles/${own}/end`, { secs: 600 });
  await waitOp(de, "esp-e0e001", 3, 2);
  assert.equal(df.got.slice(before).filter((m) => m.topic.endsWith("/draw")).length, 0, "your own canvas stays on your desk");
  assert.deepEqual((await erin.call("GET", "/api/doodles/mine")).body.map((d) => d.id), [own]);
  assert.equal((await erin.call("POST", `/api/doodles/${own}/show`, { secs: 3600 })).status, 200);
  await waitOp(de, "esp-e0e001", 3, 3);
  assert.equal((await fred.call("POST", `/api/doodles/${own}/show`, {})).status, 404);
  const fredBefore = df.got.length;
  assert.equal((await erin.call("POST", "/api/doodles/hide")).status, 200);
  await waitOp(de, "esp-e0e001", 5);
  const back = frames(de, "esp-e0e001", 5)[0].buf;
  assert.equal((back[1] << 8) | back[2], own, "back to clock names the drawing on screen");
  const lastEnd = frames(de, "esp-e0e001", 3).at(-1).buf;
  assert.equal((lastEnd[3] << 8) | lastEnd[4], 10, "older firmware gets a 10 s end first");
  const sketch = (await erin.call("POST", "/api/doodles", {})).body.id;
  await erin.call("POST", `/api/doodles/${sketch}/strokes`, { s: stroke.toString("base64") });
  await erin.call("POST", "/api/doodles/hide");
  await waitOp(de, "esp-e0e001", 5, 2);
  assert.deepEqual((await erin.call("GET", "/api/doodles/active")).body, [], "back to clock ends the open canvas");
  assert.deepEqual((await erin.call("GET", "/api/doodles/mine")).body.map((d) => d.id), [sketch, own], "and keeps the drawing");
  assert.equal(df.got.slice(fredBefore).filter((m) => m.topic.endsWith("/draw")).length, 0, "only your own desks");

  const conn = await fetch(`${base}/api/apps/spotify/connect`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  assert.equal(conn.status, 302);
  const auth = new URL(conn.headers.get("location"));
  assert.equal(auth.origin + auth.pathname, `${fx}/sa/authorize`);
  assert.deepEqual([auth.searchParams.get("client_id"), auth.searchParams.get("code_challenge_method"), auth.searchParams.get("redirect_uri")],
    ["spotify-test", "S256", `${base}/api/apps/spotify/callback`]);
  const bad = await fetch(`${base}/api/apps/spotify/callback?code=good&state=forged`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  assert.equal(bad.headers.get("location"), "/#/apps?err=oauth_state");
  const blockedState = new URL((await fetch(`${base}/api/apps/spotify/connect`, { headers: { cookie: erin.cookie() }, redirect: "manual" })).headers.get("location")).searchParams.get("state");
  const blocked = await fetch(`${base}/api/apps/spotify/callback?code=blocked&state=${blockedState}`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  assert.equal(blocked.headers.get("location"), "/#/apps?err=spotify_invite_only", "accounts Spotify hasn't allowed get a clear message");
  assert.equal((await erin.call("GET", "/api/apps")).body.music.spotify.connected, false);
  const cb = await fetch(`${base}/api/apps/spotify/callback?code=good&state=${auth.searchParams.get("state")}`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  assert.equal(cb.headers.get("location"), "/#/apps?ok=spotify");
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.music.spotify.connected, r.body.music.spotify.name], [true, "Erin S"]);
  assert.ok(!r.text.includes("ref1") && !r.text.includes("acc1"), "Spotify tokens never leave the hub");
  fxPlaying = "Blinding Lights";
  await hub.apps.tick();
  let n = await de.waitFor((m) => m.topic === "desk/esp-e0e001/next" && m.json?.k === "music", "now playing line");
  assert.deepEqual(n.json, { text: "Blinding Lights · The Weeknd", at: 0, left: false, k: "music" });
  assert.equal((await erin.call("PATCH", "/api/apps/music/spotify", { cards: true })).status, 200);
  fxPlaying = "Save Your Tears";
  clock += 16;
  await hub.apps.tick();
  let m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "NOW PLAYING", "song change card");
  assert.deepEqual([m.json.title, m.json.text], ["Save Your Tears", "The Weeknd"]);
  fxPlaying = null;
  clock += 16;
  await hub.apps.tick();
  await de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.raw === "", "now playing cleared");

  const go = (url) => fetch(url, { headers: { cookie: erin.cookie() }, redirect: "manual" }).then((x) => x.headers.get("location"));
  const lfStart = new URL(await go(`${base}/api/apps/lastfm/connect`));
  assert.equal(lfStart.origin + lfStart.pathname, `${fx}/lfauth/`);
  assert.equal(lfStart.searchParams.get("api_key"), "lastfm-test");
  const lfCb = lfStart.searchParams.get("cb");
  assert.match(lfCb, new RegExp(`^${base}/api/apps/lastfm/callback/[0-9a-f]{32}$`));
  assert.equal(await go(`${lfCb}?token=bad-token-99`), "/#/apps?err=lastfm_denied");
  assert.equal(await go(`${lfCb}?token=good-token-1`), "/#/apps?err=oauth_state", "a sign-in link works once");
  const lfCb2 = new URL(await go(`${base}/api/apps/lastfm/connect`)).searchParams.get("cb");
  assert.equal(await go(`${base}/api/apps/lastfm/callback/${"0".repeat(32)}?token=good-token-1`), "/#/apps?err=oauth_state");
  assert.equal(await go(`${lfCb2}?token=good-token-1`), "/#/apps?ok=lastfm");
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.music.lastfm.connected, r.body.music.lastfm.user, r.body.music.lastfm.signin], [true, "erin_listens", true]);
  await erin.call("DELETE", "/api/apps/lastfm");
  assert.equal((await erin.call("PUT", "/api/apps/lastfm", { user: "nobody" })).body.error, "lastfm_user");
  r = await erin.call("PUT", "/api/apps/lastfm", { user: "erin_listens" });
  assert.equal(r.status, 200, r.text);
  clock += 31;
  await hub.apps.tick();
  n = await de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.json?.text?.startsWith("Ocean Eyes"), "last.fm now playing");
  assert.equal(n.json.text, "Ocean Eyes · Billie Eilish");
  await erin.call("DELETE", "/api/apps/lastfm");
  await de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.raw === "", "cleared after disconnect");

  const hookToken = (await erin.call("GET", "/api/token")).body.token;
  const np = (b, token = hookToken) => fetch(`${base}/api/nowplaying`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(b) })
    .then(async (x) => ({ status: x.status, body: await x.json() }));
  const nextMusic = (text) => de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.json?.text === text && x.json?.k === "music", text);
  assert.equal((await np({ playing: true, title: "x" }, "nope")).status, 401);
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.music.computer.on, r.body.music.computer.seen], [true, null], "nothing reported yet");
  r = await np({ os: "mac", playing: true, title: "Midnight City", artist: "M83", app: "Spotify", error: null });
  assert.deepEqual([r.status, r.body], [200, { ok: true, off: false }]);
  await nextMusic("Midnight City · M83");
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual(r.body.music.computer, { on: true, seen: clock, app: "Spotify", os: "mac", error: null, clock: true, cards: false });
  assert.deepEqual(r.body.music.playing, { title: "Midnight City", artist: "M83", src: "computer" });
  await erin.call("PUT", "/api/apps/lastfm", { user: "erin_listens" });
  clock += 31;
  await hub.apps.tick();
  assert.equal((await erin.call("GET", "/api/apps")).body.music.playing.src, "computer", "the computer beats Last.fm's slower report");
  await erin.call("DELETE", "/api/apps/lastfm");
  await np({ os: "mac", playing: true, title: "Wait", artist: "M83", app: "Apple Music" });
  await nextMusic("Wait · M83");
  clock += 151;
  await hub.apps.tick();
  assert.equal((await erin.call("GET", "/api/apps")).body.music.playing, null, "a computer that stopped reporting (asleep, offline) is dropped");
  await np({ os: "mac", playing: true, title: "Outro", artist: "M83", app: "Spotify" });
  await nextMusic("Outro · M83");
  await np({ os: "mac", playing: false, error: "not_allowed" });
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.music.playing, r.body.music.computer.error], [null, "not_allowed"]);
  await np({ os: "mac", playing: false, error: "<script>" });
  assert.equal((await erin.call("GET", "/api/apps")).body.music.computer.error, null, "unknown error codes are dropped");
  r = await erin.call("PATCH", "/api/apps/music/computer", { on: false });
  assert.equal(r.body.computer.on, false);
  assert.deepEqual((await np({ os: "mac", playing: true, title: "Ignored", artist: "M83" })).body, { ok: true, off: true });
  assert.equal((await erin.call("GET", "/api/apps")).body.music.playing, null, "turned off: reports are ignored");
  await erin.call("PATCH", "/api/apps/music/computer", { on: true, cards: true });
  await np({ os: "windows", playing: true, title: "Back", artist: "M83", app: "Chrome" });
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.title === "Back", "song card from the computer");
  assert.equal(m.json.src, "NOW PLAYING");
  await np({ os: "windows", playing: false });
  await erin.call("PATCH", "/api/apps/music/computer", { cards: false });

  const pcr = (b) => fetch(`${base}/api/computer`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hookToken}` }, body: JSON.stringify({ os: "mac", playing: false, ...b }) })
    .then((x) => x.json());
  const cards = (src) => de.got.filter((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === src.toUpperCase());
  await pcr({ badges: { Slack: 2, "App Store": 1, "\u200eWhatsApp": -1 } });
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "SLACK", "slack badge card");
  assert.deepEqual([m.json.title, m.json.color], ["2 unread", "purple"]);
  await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "WHATSAPP" && x.json?.title === "Something new", "whatsapp dot card");
  await pcr({ badges: { Slack: 3, "App Store": 1, WhatsApp: -1 } });
  await de.quiet(80);
  assert.equal(cards("App Store").length, 0, "App Store is muted by default");
  assert.equal(cards("Slack").length, 1, "one card a minute per app");
  clock += 61;
  await pcr({ badges: { Slack: 5 } });
  await de.waitFor(() => cards("Slack").length === 2 && cards("Slack")[1].json.title === "5 unread", "next slack card");
  await pcr({ badges: { Slack: 4 } });
  r = await erin.call("PATCH", "/api/apps/computer", { mute: { Slack: true } });
  assert.deepEqual(r.body.apps.find((x) => x.app === "Slack"), { app: "Slack", count: 4, muted: true });
  assert.deepEqual(r.body.apps.map((x) => x.app).sort(), ["App Store", "Slack", "WhatsApp"]);
  clock += 61;
  await pcr({ badges: { Slack: 9 } });
  await de.quiet(80);
  assert.equal(cards("Slack").length, 2, "muted apps send no cards");

  const erinFor = async () => (await fred.call("GET", "/api/friends")).body.find((f) => f.username === "erin").presence;
  assert.deepEqual(await erinFor(), { away: false, since: 0 });
  await pcr({ away: true, idle: 900 });
  assert.deepEqual(await erinFor(), { away: true, since: clock - 900 });
  await erin.call("PATCH", "/api/apps/computer", { presence: false });
  assert.equal(await erinFor(), null, "presence can be hidden");
  await erin.call("PATCH", "/api/apps/computer", { presence: true });
  await pcr({ away: false });
  clock += 301;
  assert.deepEqual(await erinFor(), { away: true, since: clock - 301 }, "a computer that stopped reporting counts as away");

  await pcr({ calendar: "ok", events: [{ t: "Design review", s: clock + 600, e: clock + 2400, l: "Room 2" }, { t: "bad", s: "x" }] });
  r = await erin.call("GET", "/api/apps");
  assert.equal(r.body.calendar.fromComputer, 1);
  assert.deepEqual(r.body.calendar.upcoming, [{ title: "Design review", start: clock + 600 }]);
  assert.equal(r.body.computer.cal, "ok");
  await de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.json?.text === "Design review" && x.json?.at === clock + 600, "next meeting from the computer");
  await hub.apps.tick();
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "CALENDAR" && x.json?.title === "Design review", "meeting reminder");
  assert.match(m.json.text, /^in 10 min · \d\d:\d\d · Room 2$/);
  await erin.call("PATCH", "/api/apps/computer", { calendar: false });
  assert.deepEqual((await erin.call("GET", "/api/apps")).body.calendar.upcoming, [], "computer calendar can be turned off");
  await erin.call("PATCH", "/api/apps/computer", { calendar: true });
  await pcr({ calendar: "ok", events: [] });

  const gStart = new URL(await go(`${base}/api/apps/google/connect`));
  assert.equal(gStart.origin + gStart.pathname, `${fx}/ga/o/oauth2/v2/auth`);
  assert.deepEqual(["client_id", "redirect_uri", "access_type", "prompt", "code_challenge_method"].map((k) => gStart.searchParams.get(k)),
    ["google-test", `${base}/api/apps/google/callback`, "offline", "consent", "S256"]);
  assert.ok(gStart.searchParams.get("scope").split(" ").includes("https://www.googleapis.com/auth/calendar.readonly"));
  assert.equal(await go(`${base}/api/apps/google/callback?code=noscope&state=${gStart.searchParams.get("state")}`), "/#/apps?err=google_scope", "calendar box unticked");
  assert.equal(await go(`${base}/api/apps/google/callback?error=access_denied&state=x`), "/#/apps?err=google_denied");
  const gState = new URL(await go(`${base}/api/apps/google/connect`)).searchParams.get("state");
  assert.equal(await go(`${base}/api/apps/google/callback?code=good&state=${gState}`), "/#/apps?ok=google");
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.calendar.google.connected, r.body.calendar.google.email, r.body.calendar.google.upcoming], [true, "erin@example.com", 2]);
  assert.deepEqual(r.body.calendar.upcoming.map((e) => e.title), ["1:1 with Sam", "Team sync"], "selected calendars only; no all-day, declined or cancelled events");
  assert.ok(!r.text.includes("gref1") && !r.text.includes("gacc1"), "Google tokens never leave the hub");
  await de.waitFor((x) => x.topic === "desk/esp-e0e001/next" && x.json?.text === "1:1 with Sam", "next meeting from Google");
  clock += 3600;
  await hub.apps.tick();
  assert.equal(fxGoogleToken, "gacc2", "the hub refreshes Google's access token itself");
  assert.deepEqual((await erin.call("GET", "/api/apps")).body.calendar.google, { configured: true, connected: true, email: "erin@example.com", ok: true, error: null, at: clock, upcoming: 2 });
  await erin.call("DELETE", "/api/apps/google");
  await sleep(50);
  assert.equal(fxGoogleRevoked, "gref1", "disconnecting revokes access at Google");
  r = await erin.call("GET", "/api/apps");
  assert.deepEqual([r.body.calendar.google.connected, r.body.calendar.upcoming.length], [false, 0]);

  const nowMin = Math.floor((clock % 86400) / 60);
  const nextMin = (nowMin + 1) % 1440;
  assert.equal((await erin.call("POST", "/api/reminders", { kind: "at", label: "Meds", at: nextMin, days: 0 })).body.error, "days");
  assert.equal((await erin.call("POST", "/api/reminders", { kind: "every", label: "Water", every: 7, start: 0, end: 600, days: 127 })).body.error, "every");
  r = await erin.call("POST", "/api/reminders", { kind: "at", label: "Meds", at: nextMin, days: 127 });
  assert.equal(r.status, 200, r.text);
  await hub.apps.tick();
  await de.quiet(80);
  assert.equal(de.got.filter((x) => x.topic.endsWith("/card") && x.json?.src === "REMINDER").length, 0, "not yet");
  clock = Math.floor(clock / 60) * 60 + 60 + 5;
  await hub.apps.tick();
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "REMINDER", "reminder card");
  assert.equal(m.json.title, "Meds");
  clock += 30;
  await hub.apps.tick();
  await de.quiet(80);
  assert.equal(de.got.filter((x) => x.topic.endsWith("/card") && x.json?.src === "REMINDER").length, 1, "once per occurrence");

  assert.equal((await erin.call("PUT", "/api/apps/rain", { on: true })).body.error, "no_location");
  await de.publishAsync("desk/esp-e0e001/up/settings", JSON.stringify({ rev: 0, lat: 45.76, lon: 4.83, packs: ["pixel"] }), { qos: 1 });
  await sleep(100);
  r = await erin.call("PUT", "/api/apps/rain", { on: true });
  assert.equal(r.status, 200, r.text);
  await hub.apps.tick();
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "WEATHER", "rain card");
  assert.equal(m.json.title, "Rain soon");
  assert.match(m.json.text, /^in about \d+ min · 1\.8 mm in the next hour$/);
  clock += 15 * 60 + 1;
  await hub.apps.tick();
  await de.quiet(80);
  assert.equal(de.got.filter((x) => x.topic.endsWith("/card") && x.json?.src === "WEATHER").length, 1, "one alert per rain spell");

  const sc = await fetch(`${base}/api/apps/slack/connect`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  const sauth = new URL(sc.headers.get("location"));
  assert.equal(sauth.origin + sauth.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(sauth.searchParams.get("user_scope"), "search:read");
  const scb = await fetch(`${base}/api/apps/slack/callback?code=good&state=${sauth.searchParams.get("state")}`, { headers: { cookie: erin.cookie() }, redirect: "manual" });
  assert.equal(scb.headers.get("location"), "/#/apps?ok=slack");
  fxSlackTs = String(clock + 20) + ".000100";
  clock += 61;
  await hub.apps.tick();
  m = await de.waitFor((x) => x.topic === "desk/esp-e0e001/card" && x.json?.src === "SLACK" && x.json?.title?.includes(" in #"), "slack card");
  assert.deepEqual([m.json.title, m.json.text], ["sam in #general", "hey @erin can you look at the PR?"]);
  clock += 61;
  await hub.apps.tick();
  await de.quiet(80);
  assert.equal(de.got.filter((x) => x.topic.endsWith("/card") && x.json?.src === "SLACK" && x.json?.title?.includes(" in #")).length, 1, "no repeats, own messages ignored");

  assert.equal((await erin.call("PUT", "/api/apps/email", { host: "bad host!", user: "e@x.io", pass: "p" })).body.error, "email_host");
  assert.equal((await erin.call("PUT", "/api/apps/email", { host: "127.0.0.1", user: "e@x.io", pass: "app-pass" })).body.error, "email_unreachable");
  assert.equal((await erin.call("DELETE", "/api/apps/nope")).status, 404);
});

test("photos and GIFs: converted on the hub, streamed to your desk or a friend's, back to clock", async () => {
  hub.media.pace = 0;
  const gina = user(), hank = user(), ivy = user();
  for (const [u, name] of [[gina, "gina"], [hank, "hank"], [ivy, "ivy"]]) {
    const r = await u.call("POST", "/api/register", { username: name, displayName: name[0].toUpperCase() + name.slice(1), password: "password-" + name, invite: "letmein", tz: "UTC" });
    assert.equal(r.status, 200, r.text);
  }
  await gina.call("POST", "/api/friends", { username: "hank" });
  await hank.call("POST", "/api/friends", { username: "gina" });
  const desk = async (who, chip) => {
    const hl = await anon.call("POST", "/api/device/hello", { chip, fw: "1.4.9", secret: "" });
    assert.equal((await who.call("POST", "/api/devices/pair", { code: hl.body.pairCode, name: "Desk" })).status, 200);
    const c = await device(chip, hl.body.secret);
    await c.subscribeAsync(`desk/${chip}/#`, { qos: 1 });
    return c;
  };
  const dg = await desk(gina, "esp-a1a001"), dh = await desk(hank, "esp-b1b001");
  const upload = (who, body, type, q = "") => fetch(`${base}/api/media${q}`, { method: "POST", headers: { cookie: who.cookie(), "content-type": type }, body })
    .then(async (x) => ({ status: x.status, body: await x.json() }));
  const received = async (c, chip, n = 1) => {
    const ends = () => c.got.filter((m) => m.topic === `desk/${chip}/media` && m.buf[0] === 3);
    await c.waitFor(() => ends().length >= n, "media end on " + chip);
    const seq = ends()[n - 1].buf.readUInt16BE(1);
    const mine = c.got.filter((m) => m.topic === `desk/${chip}/media` && m.buf.readUInt16BE(1) === seq);
    const begin = mine.find((m) => m.buf[0] === 1).buf;
    const parts = mine.filter((m) => m.buf[0] === 2).map((m) => ({ off: m.buf.readUInt32BE(3), data: m.buf.subarray(7) }));
    parts.forEach((p, i) => assert.equal(p.off, i ? parts[i - 1].off + parts[i - 1].data.length : 0, "chunks arrive in order"));
    const data = Buffer.concat(parts.map((p) => p.data));
    assert.ok(parts.every((p) => p.data.length <= 700), "chunks fit the desk's 768-byte messages");
    return { seq, data, size: begin.readUInt32BE(3), crc: begin.readUInt32BE(7), secs: begin.readUInt16BE(11), from: begin.subarray(14, 14 + begin[13]).toString() };
  };

  assert.deepEqual(await upload(gina, Buffer.from("not an image"), "image/png"), { status: 400, body: { error: "media_unreadable" } });
  const w = 120, h = 90, pages = 4;
  const raw = Buffer.alloc(w * h * pages * 4);
  for (let p = 0; p < pages; p++) for (let i = 0; i < w * h; i++) {
    const x = i % w, o = (p * w * h + i) * 4;
    raw.set(x >= p * 25 && x < p * 25 + 30 ? [255, 120, 0, 255] : [10, 10, 40, 255], o);
  }
  const gif = await sharp(raw, { raw: { width: w, height: h * pages, channels: 4, pageHeight: h } }).gif({ delay: [100, 100, 100, 300], loop: 0 }).toBuffer();
  let r = await upload(gina, gif, "image/gif");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.kind, r.body.frames], ["gif", 4]);
  const gifId = r.body.id;
  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
  r = await upload(gina, photo, "image/jpeg", "?fit=contain");
  assert.deepEqual([r.status, r.body.kind, r.body.frames], [200, "image", 1]);
  const list = (await gina.call("GET", "/api/media")).body;
  assert.deepEqual(list.items.map((x) => x.id), [r.body.id, gifId]);
  const prev = await fetch(`${base}/api/media/${gifId}/preview`, { headers: { cookie: gina.cookie() } });
  assert.deepEqual([prev.status, prev.headers.get("content-type")], [200, "image/webp"]);

  r = await gina.call("POST", `/api/media/${gifId}/show`, { secs: 600 });
  assert.deepEqual(r.body, { devices: 1 });
  const got = await received(dg, "esp-a1a001");
  assert.deepEqual([got.data.length, got.crc, got.secs, got.from], [got.size, zlib.crc32(got.data) >>> 0, 600, "you"]);
  assert.equal(got.data.subarray(0, 4).toString(), "DKM1");
  assert.equal(got.data.readUInt16LE(4), 4);
  assert.equal((await gina.call("GET", "/api/media")).body.deliveries[0].state, "sending");
  await dg.publishAsync("desk/esp-a1a001/up/media", JSON.stringify({ id: got.seq, ok: true }), { qos: 1 });
  await sleep(100);
  assert.deepEqual((await gina.call("GET", "/api/media")).body.deliveries[0], { chip: "esp-a1a001", media: gifId, state: "ok", error: null, at: clock });

  assert.equal((await gina.call("POST", `/api/media/${gifId}/send`, { to: "ivy" })).status, 403, "friends only");
  assert.equal((await hank.call("POST", `/api/media/${gifId}/show`, {})).status, 404, "only your own uploads");
  r = await gina.call("POST", `/api/media/${gifId}/send`, { to: "hank" });
  assert.deepEqual(r.body, { devices: 1 });
  const atHank = await received(dh, "esp-b1b001");
  assert.deepEqual([atHank.from, atHank.data.equals(got.data)], ["Gina", true]);
  const chat = (await hank.call("GET", "/api/messages?with=gina")).body.find((m) => m.kind === "media");
  assert.deepEqual(chat.media, { id: gifId, kind: "gif" });
  assert.equal((await fetch(`${base}/api/media/${gifId}/preview`, { headers: { cookie: hank.cookie() } })).status, 200, "the friend can see what was sent");
  assert.equal((await fetch(`${base}/api/media/${gifId}/preview`, { headers: { cookie: ivy.cookie() } })).status, 404);

  assert.equal((await gina.call("POST", "/api/doodles/hide")).status, 200);
  await dg.waitFor((m) => m.topic === "desk/esp-a1a001/media" && m.buf[0] === 4, "media stop");
  await dg.waitFor((m) => m.topic === "desk/esp-a1a001/draw" && m.buf[0] === 5, "back to clock");
  assert.equal((await gina.call("DELETE", `/api/media/${gifId}`)).status, 200);
  assert.equal((await gina.call("POST", `/api/media/${gifId}/show`, {})).status, 404);
  for (const c of [dg, dh]) await c.endAsync();
});
