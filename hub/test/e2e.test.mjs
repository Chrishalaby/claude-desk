// End-to-end test: real hub (HTTP + MQTT/TLS) on random ports, fake clock, mqtt.js as the device.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { startHub } from "../dist/hub.js";
import { configFromEnv } from "../dist/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-hub-"));
const fwDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-fw-"));
const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdesk-packs-"));
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const FW_BIN = crypto.randomBytes(50_000);
fs.writeFileSync(path.join(fwDir, "claude-desk.bin"), FW_BIN);
fs.writeFileSync(path.join(fwDir, "version.txt"), "1.4.0\n");
const PACK_BIN = Buffer.concat([Buffer.from("CDPK\x01\x00\x00\x00", "latin1"), crypto.randomBytes(1000)]);
const PACK_PNG = Buffer.from("89504e470d0a1a0a", "hex");
fs.writeFileSync(path.join(packsDir, "testpack.bin"), PACK_BIN);
fs.writeFileSync(path.join(packsDir, "testpack.png"), PACK_PNG);
fs.writeFileSync(path.join(packsDir, "index.json"), JSON.stringify({ packs: [
  { id: "testpack", name: "Test Pack", license: "MIT", size: 1, md5: "stale" },
  { id: "ghost", name: "No file", license: "", size: 1, md5: "x" },
] }));
let clock = Math.floor(Date.now() / 1000);
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
  return { call };
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
    got.push({ topic, raw: payload.toString(), json: payload.length ? JSON.parse(payload.toString()) : null, retain: packet.retain });
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

test("friends: request, accept, relationship change, decline, partner", async () => {
  let r = await alice.call("POST", "/api/friends", { username: "bob", rel: "partner" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.rel, r.body.pendingRel, r.body.pendingFrom], [null, "partner", "me"]);
  r = await bob.call("GET", "/api/friends");
  assert.deepEqual(r.body.map((f) => [f.username, f.pendingRel, f.pendingFrom]), [["alice", "partner", "them"]]);
  // the requester can't accept their own request
  assert.equal((await alice.call("POST", "/api/friends/bob/accept")).status, 404);
  r = await bob.call("POST", "/api/friends/alice/accept");
  assert.equal(r.status, 200);
  assert.equal(r.body.rel, "partner");

  // carol <-> alice: friends; a change to partner is declined and the friendship stays
  await carol.call("POST", "/api/friends", { username: "alice", rel: "friend" });
  r = await alice.call("POST", "/api/friends/carol/accept");
  assert.equal(r.body.rel, "friend");
  await carol.call("POST", "/api/friends", { username: "alice", rel: "partner" });
  r = await alice.call("GET", "/api/friends");
  const c = r.body.find((f) => f.username === "carol");
  assert.deepEqual([c.rel, c.pendingRel, c.pendingFrom], ["friend", "partner", "them"]);
  assert.equal((await alice.call("POST", "/api/friends/carol/decline")).status, 200);
  r = await alice.call("GET", "/api/friends");
  assert.deepEqual(r.body.map((f) => [f.username, f.rel, f.pendingRel]), [["bob", "partner", null], ["carol", "friend", null]]);

  assert.equal((await alice.call("POST", "/api/friends", { username: "alice", rel: "friend" })).status, 400);
  assert.equal((await alice.call("POST", "/api/friends", { username: "nobody", rel: "friend" })).status, 404);
  assert.equal((await alice.call("POST", "/api/friends", { username: "bob", rel: "lover" })).status, 400);
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
  assert.deepEqual(cfg.json, { paired: true, owner: "alice", name: "Desk", hub: base });
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

  await a.publishAsync(`desk/${devA.chip}/up/status`, JSON.stringify({ fw: "1.3.2", ip: "192.168.1.107", rssi: -40, heap: 23000, up: 3600 }), { qos: 1 });
  await sleep(100);
  assert.equal(a.got.filter((m) => m.topic.includes("/up/")).length, 0, "up/ messages are not echoed to the device");
  const r = await alice.call("GET", "/api/devices");
  assert.equal(r.body.length, 1);
  assert.deepEqual([r.body[0].fw, r.body[0].ip, r.body[0].rssi, r.body[0].online], ["1.3.2", "192.168.1.107", -40, true]);

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

test("messages: text + reactions, retained delivery, partner-only rule, limits, history", async () => {
  const b = devB.client;
  let r = await alice.call("POST", "/api/messages", { to: "bob", kind: "text", text: "see you at 8?" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.devices, 1);
  const id1 = r.body.message.id;
  let m = await b.waitFor((x) => x.topic === `desk/${devB.chip}/msg`, "text msg");
  assert.deepEqual(m.json, { id: id1, from: "alice", name: "Alice", rel: "partner", kind: "text", text: "see you at 8?", reaction: "", t: clock });

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

  // partner-only reactions are refused between friends
  r = await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "heart" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "partner_only");
  r = await carol.call("POST", "/api/messages", { to: "alice", kind: "reaction", reaction: "wave" });
  assert.equal(r.status, 200);
  m = await devA.client.waitFor((x) => x.topic === `desk/${devA.chip}/msg`, "wave to alice");
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
    lat: 33.97123456, lon: 35.62, place: "Naccache, Lebanon" });
  assert.equal(r.status, 200, r.text);
  let m = await a.waitFor((x) => x.topic === `desk/${devA.chip}/set`, "set");
  const rev1 = m.json.rev;
  assert.ok(rev1 >= clock);
  assert.deepEqual(m.json, { rev: rev1, layout: 0, soft: 1, casper: 0, pack: "testpack", bday: 60, bnight: 5, nstart: 23, nend: 6,
    lat: 33.9712, lon: 35.62, packUrl: `${base}/packs/testpack.bin`, packMd5: md5(PACK_BIN) });
  assert.equal(m.json.place, undefined, "place stays on the hub");

  // partial update, same second: rev still increases, other keys kept, pixel has no packUrl
  r = await alice.call("PUT", url, { bday: 70, pack: "pixel" });
  m = await a.waitFor((x) => x.topic === `desk/${devA.chip}/set`, "set 2");
  assert.ok(m.json.rev > rev1);
  assert.deepEqual([m.json.bday, m.json.layout, m.json.pack, m.json.packUrl, m.json.lat], [70, 0, "pixel", undefined, 33.9712]);
  devA.rev = m.json.rev;

  for (const bad of [{ bday: 101 }, { nstart: 24 }, { layout: "x" }, { pack: "nope" }, { lat: 95, lon: 0 }, { lat: 1 }, {}]) {
    assert.equal((await alice.call("PUT", url, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await bob.call("PUT", url, { bday: 1 })).status, 404);
  assert.equal((await bob.call("GET", url)).status, 404);

  // the desk reports what it runs
  await a.publishAsync(`desk/${devA.chip}/up/settings`, JSON.stringify({ rev: devA.rev, layout: 0, soft: 1, casper: 0, pack: "pixel",
    bday: 70, bnight: 5, nstart: 23, nend: 6, lat: 33.9712, lon: 35.62, packs: ["pixel", "testpack"], junk: "x".repeat(50) }), { qos: 1 });
  await sleep(100);
  r = await alice.call("GET", url);
  assert.equal(r.body.place, "Naccache, Lebanon");
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
