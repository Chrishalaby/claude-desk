import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { startBroker, type Broker } from "./broker.js";
import type { Config } from "./config.js";
import { kvGet, kvSet, openDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { Service } from "./service.js";
import { loadTls, type TlsMaterial } from "./tls.js";
import { randomHex } from "./util.js";

export interface Hub {
  httpPort: number;
  mqttPort: number;
  tls: TlsMaterial;
  service: Service;
  broker: Broker;
  tick(): void;
  close(): Promise<void>;
}

export async function startHub(cfg: Config): Promise<Hub> {
  const log = (...a: unknown[]) => { if (cfg.log) console.log(new Date().toISOString(), ...a); };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dataDir);

  let sessionSecret = cfg.sessionSecret ?? kvGet(db, "session_secret");
  if (!sessionSecret) {
    sessionSecret = randomHex(32);
    kvSet(db, "session_secret", sessionSecret);
  }

  const cn = cfg.mqttPublicHost ?? "claude-desk-hub";
  const tlsMat = await loadTls(cfg.dataDir, cfg.tlsCert, cfg.tlsKey, cn);
  const svc = new Service(db, cfg, tlsMat);

  const broker = await startBroker(cfg.mqttPort, cfg.httpHost, tlsMat, {
    authenticate: (chip, secret) => svc.deviceAuth(chip, secret),
    onReady: (chip) => svc.deviceOnline(chip),
    onGone: (chip) => svc.touchDevice(chip),
    onUp: (chip, sub, payload) => {
      if (sub === "status") svc.deviceStatus(chip, payload);
      else if (sub === "settings") svc.deviceSettingsReport(chip, payload);
    },
    log,
  });
  svc.broker = broker;
  svc.republishAll();

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 16 * 1024 });
  await app.register(cookie, { secret: sessionSecret });
  registerRoutes(app, svc, db, cfg);
  await app.listen({ port: cfg.httpPort, host: cfg.httpHost });
  const httpPort = (app.server.address() as AddressInfo).port;

  const timers = [
    setInterval(() => { try { svc.tick(); } catch (e) { log("tick failed", (e as Error).message); } }, 1000),
    setInterval(() => { try { svc.housekeeping(); } catch (e) { log("housekeeping failed", (e as Error).message); } }, 3600_000),
  ];
  for (const t of timers) t.unref();

  log(`http on :${httpPort}, mqtt/tls on :${broker.port}, data in ${cfg.dataDir}`);
  log(`mqtt cert RSA-${tlsMat.keyBits} sha256 ${tlsMat.fingerprint}`);
  log(`mqtt cert sha1 ${tlsMat.fingerprint1}`);
  log(`public url ${cfg.publicUrl ?? "(from requests)"}, mqtt public ${cfg.mqttPublicHost ?? "(request host)"}:${cfg.mqttPublicPort ?? broker.port}`);
  if (!cfg.inviteCode) log("WARNING: HUB_INVITE_CODE not set - anyone can register");
  if (!fs.existsSync(path.join(cfg.clientDir, "install.sh"))) log(`note: client files not found in ${cfg.clientDir}`);
  const fw = svc.firmware();
  log(fw ? `firmware ${fw.version} (${fw.size} bytes, md5 ${fw.md5})` : `note: no firmware in ${cfg.firmwareDir} (needs claude-desk.bin + version.txt)`);
  log(`packs: ${svc.packs().map((p) => p.id).join(", ") || "(none)"} from ${cfg.packsDir}`);

  return {
    httpPort,
    mqttPort: broker.port,
    tls: tlsMat,
    service: svc,
    broker,
    tick: () => svc.tick(),
    async close() {
      for (const t of timers) clearInterval(t);
      await app.close();
      await broker.close();
      db.close();
    },
  };
}
