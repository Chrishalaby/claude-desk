import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { Aedes, type Client } from "aedes";
import { TLS12_CIPHERS, type TlsMaterial } from "./tls.js";

export const CHIP_RE = /^esp-[0-9a-f]{1,8}$/;
export const MAX_DEVICE_PAYLOAD = 768;
const MAX_UP_PAYLOAD = 1024;

export interface BrokerHooks {
  authenticate(chip: string, secret: string): boolean;
  onReady(chip: string): void;
  onGone(chip: string): void;
  onUp(chip: string, subtopic: string, payload: Buffer): void;
  log(...a: unknown[]): void;
}

export interface Broker {
  port: number;
  publish(topic: string, payload: object | null, retain?: boolean, done?: () => void): void;
  /** Disconnects a device (after `delayMs`, so queued messages can be flushed first). */
  kick(chip: string, delayMs?: number): void;
  isOnline(chip: string): boolean;
  close(): Promise<void>;
}

export async function startBroker(port: number, host: string, mat: TlsMaterial, hooks: BrokerHooks): Promise<Broker> {
  const aedes = await Aedes.createBroker({
    drainTimeout: 30_000,
    connectTimeout: 15_000,
    maxTopicLevels: 8,
    heartbeatInterval: 3_600_000,
  });
  const online = new Set<string>();

  aedes.preConnect = (_client, packet, cb) => {
    // only MQTT 3.1.1 / 5, clientId must look like a chip id
    cb(null, typeof packet.clientId === "string" && CHIP_RE.test(packet.clientId));
  };

  aedes.authenticate = (client, username, password, cb) => {
    const chip = client.id;
    const ok = username === chip && !!password && hooks.authenticate(chip, password.toString("utf8"));
    if (!ok) {
      const err = Object.assign(new Error("bad credentials"), { returnCode: 4 as const });
      return cb(err as any, false);
    }
    cb(null, true);
  };

  aedes.authorizeSubscribe = (client, sub, cb) => {
    const prefix = `desk/${client.id}/`;
    const t = sub.topic;
    cb(null, typeof t === "string" && t.startsWith(prefix) ? sub : null); // null => SUBACK 0x80
  };

  aedes.authorizePublish = (client, packet, cb) => {
    if (!client) return cb(new Error("no client"));
    const prefix = `desk/${client.id}/up`;
    if (!(packet.topic === prefix || packet.topic.startsWith(prefix + "/"))) return cb(new Error("topic not allowed"));
    if ((packet.payload?.length ?? 0) > MAX_UP_PAYLOAD) return cb(new Error("payload too large"));
    packet.retain = false;
    cb(null);
  };

  aedes.on("clientReady", (client: Client) => {
    online.add(client.id);
    try { hooks.onReady(client.id); } catch (e) { hooks.log("onReady failed", (e as Error).message); }
  });
  aedes.on("clientDisconnect", (client: Client) => {
    // a reconnect with the same id replaces the old client; only mark offline if no live one remains
    const live = (aedes as any).clients?.[client.id];
    if (!live || live === client) online.delete(client.id);
    try { hooks.onGone(client.id); } catch { /* ignore */ }
  });
  aedes.on("publish", (packet, client) => {
    if (!client) return;
    const prefix = `desk/${client.id}/up`;
    if (packet.topic === prefix || packet.topic.startsWith(prefix + "/")) {
      try {
        hooks.onUp(client.id, packet.topic.slice(prefix.length + 1), Buffer.from(packet.payload as any));
      } catch (e) {
        hooks.log("up handler failed", (e as Error).message);
      }
    }
  });
  aedes.on("clientError", () => { /* noisy; clients drop all the time */ });
  aedes.on("connectionError", () => { /* bad TLS / bad auth */ });

  const server = tls.createServer(
    {
      cert: mat.cert,
      key: mat.key,
      minVersion: "TLSv1.2",
      ciphers: TLS12_CIPHERS,
      honorCipherOrder: true,
      handshakeTimeout: 20_000,
    },
    (socket) => {
      socket.setNoDelay(true);
      socket.on("error", () => {});
      aedes.handle(socket);
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => res());
  });

  return {
    port: (server.address() as AddressInfo).port,
    publish(topic, payload, retain = true, done) {
      const buf = payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
      aedes.publish({ cmd: "publish", topic, payload: buf, qos: 1, retain, dup: false } as any, (err) => {
        if (err) hooks.log("publish failed", topic, err.message);
        done?.();
      });
    },
    kick(chip, delayMs = 0) {
      const target = (aedes as any).clients?.[chip] as Client | undefined;
      if (!target) return;
      const t = setTimeout(() => {
        if ((aedes as any).clients?.[chip] === target) {
          target.close();
          online.delete(chip);
        }
      }, delayMs);
      t.unref();
    },
    isOnline: (chip) => online.has(chip),
    close: () =>
      new Promise<void>((res) => {
        for (const c of Object.values((aedes as any).clients ?? {})) (c as Client).close();
        aedes.close(() => server.close(() => res()));
      }),
  };
}
