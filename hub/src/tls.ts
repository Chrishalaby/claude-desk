import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";

export interface TlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 of the DER certificate, colon-separated uppercase hex. */
  fingerprint: string;
  /** SHA-1 of the DER certificate (what ESP8266 BearSSL setFingerprint() takes) - logged only. */
  fingerprint1: string;
  /** Public key of the cert as SPKI PEM (for BearSSL setKnownKey). */
  pubkey: string;
  keyBits: number | undefined;
}

/**
 * Cipher list offered to TLS 1.2 clients. ECDHE-RSA-AES128-GCM-SHA256 first: it is what the
 * ESP8266 (BearSSL) handles best. Order is honoured. TLS 1.3 suites stay Node's defaults.
 */
export const TLS12_CIPHERS = [
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES128-SHA256",
  "ECDHE-RSA-AES128-SHA",
].join(":");

function describe(cert: string, key: string): TlsMaterial {
  const x = new crypto.X509Certificate(cert);
  crypto.createPrivateKey(key); // throws if unusable
  const fp = (alg: string) => crypto.createHash(alg).update(x.raw).digest("hex").toUpperCase().match(/../g)!.join(":");
  const pub = x.publicKey;
  return {
    cert,
    key,
    fingerprint: fp("sha256"),
    fingerprint1: fp("sha1"),
    pubkey: pub.export({ type: "spki", format: "pem" }).toString(),
    keyBits: pub.asymmetricKeyDetails?.modulusLength,
  };
}

/** Uses MQTT_TLS_CERT/KEY if given, otherwise a self-signed RSA-2048 cert persisted in dataDir. */
export async function loadTls(dataDir: string, envCert: string | null, envKey: string | null, cn: string): Promise<TlsMaterial> {
  if (envCert && envKey) return describe(envCert, envKey);
  const certFile = path.join(dataDir, "mqtt-cert.pem");
  const keyFile = path.join(dataDir, "mqtt-key.pem");
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return describe(fs.readFileSync(certFile, "utf8"), fs.readFileSync(keyFile, "utf8"));
  }
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 25);
  const pems = await selfsigned.generate([{ name: "commonName", value: cn }], {
    keyType: "rsa",
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
  } as any);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  return describe(pems.cert, pems.private);
}
