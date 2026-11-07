import path from "node:path";

export interface Config {
  dataDir: string;
  httpHost: string;
  httpPort: number;
  mqttPort: number;
  /** Public base URL of the hub, e.g. https://hub.up.railway.app (no trailing slash). Null = derive from request. */
  publicUrl: string | null;
  mqttPublicHost: string | null;
  mqttPublicPort: number | null;
  inviteCode: string | null;
  sessionSecret: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  clientDir: string;
  publicDir: string;
  /** firmware/dist: claude-desk.bin + version.txt */
  firmwareDir: string;
  /** hub/packs: <id>.bin, <id>.png, index.json */
  packsDir: string;
  /** Clock in unix seconds (injectable for tests). */
  now: () => number;
  log: boolean;
  githubApi: string;
  quotesApi: string;
  allowPrivateFetch: boolean;
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
/** PEM from env: allow literal "\n" escapes (Railway variables are single-line). */
const pem = (v: string | undefined) => (nonEmpty(v) ? v!.replace(/\\n/g, "\n") : null);

export function configFromEnv(env = process.env): Config {
  const here = path.dirname(new URL(import.meta.url).pathname); // dist/
  const publicUrl = nonEmpty(env.PUBLIC_URL) ?? (nonEmpty(env.RAILWAY_PUBLIC_DOMAIN) ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);
  return {
    dataDir: path.resolve(nonEmpty(env.DATA_DIR) ?? "./data"),
    httpHost: nonEmpty(env.HOST) ?? "0.0.0.0",
    httpPort: num(env.PORT) ?? 3000,
    mqttPort: num(env.MQTT_PORT) ?? 8883,
    publicUrl: publicUrl ? publicUrl.replace(/\/+$/, "") : null,
    mqttPublicHost: nonEmpty(env.MQTT_PUBLIC_HOST) ?? nonEmpty(env.RAILWAY_TCP_PROXY_DOMAIN),
    mqttPublicPort: num(env.MQTT_PUBLIC_PORT) ?? num(env.RAILWAY_TCP_PROXY_PORT),
    inviteCode: nonEmpty(env.HUB_INVITE_CODE),
    sessionSecret: nonEmpty(env.SESSION_SECRET),
    tlsCert: pem(env.MQTT_TLS_CERT),
    tlsKey: pem(env.MQTT_TLS_KEY),
    clientDir: path.resolve(nonEmpty(env.CLIENT_DIR) ?? path.join(here, "..", "..", "client")),
    publicDir: path.join(here, "..", "public"),
    firmwareDir: path.resolve(nonEmpty(env.FIRMWARE_DIR) ?? path.join(here, "..", "..", "firmware", "dist")),
    packsDir: path.resolve(nonEmpty(env.PACKS_DIR) ?? path.join(here, "..", "packs")),
    now: () => Date.now() / 1000,
    log: env.HUB_QUIET !== "1",
    githubApi: (nonEmpty(env.GITHUB_API) ?? "https://api.github.com").replace(/\/+$/, ""),
    quotesApi: (nonEmpty(env.QUOTES_API) ?? "https://query1.finance.yahoo.com").replace(/\/+$/, ""),
    allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === "1",
  };
}
