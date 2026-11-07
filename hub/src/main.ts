import { configFromEnv } from "./config.js";
import { startHub } from "./hub.js";

const hub = await startHub(configFromEnv());

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try { await hub.close(); } finally { process.exit(0); }
  });
}
