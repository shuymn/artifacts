/**
 * The browser tests' Worker: wrangler's test harness with D1 and R2, as the end-to-end test runs it, on a localhost
 * configuration, so Access is not verified (ACC-2) and every host is a name under `localhost`, which browsers resolve
 * to the loopback address and treat as secure, so they send Fetch Metadata. The hosts carry the harness's port, which
 * is known only once it listens; the configuration is then updated with it, which keeps the port.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createTestHarness, type TestHarness } from "wrangler";

import { pinCf } from "./cf.ts";
import { PORT_VARIABLE, TIME_ZONE, TOKEN } from "./support.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function worker(port: string) {
  return {
    configPath: "./wrangler.jsonc",
    vars: {
      APP_HOST: `app.localhost:${port}`,
      API_HOST: `api.localhost:${port}`,
      CONTENT_HOST_SUFFIX: `-art.localhost:${port}`,
      PUBLIC_HOST_SUFFIX: `-pub.localhost:${port}`,
      ARCHIVE_AFTER_DAYS: "30",
    },
    secrets: { API_TOKENS: JSON.stringify({ browser: createHash("sha256").update(TOKEN).digest("hex") }) },
  };
}

/**
 * Starts the Worker with `request.cf` pinned to `TIME_ZONE` (cf.ts), gives the tests its port, and returns the
 * teardown that stops it and undoes the pin; a start that fails does the same.
 */
export default async function start(): Promise<() => Promise<void>> {
  const unpin = await pinCf(TIME_ZONE);
  let server: TestHarness | undefined;
  const stop = async () => {
    try {
      await server?.close();
    } finally {
      await unpin();
    }
  };
  try {
    server = createTestHarness({ root: ROOT, workers: [worker("1")] });
    const { url } = await server.listen();
    await server.update({ root: ROOT, workers: [worker(url.port)] });
    await server.getWorker().applyD1Migrations("DB");
    process.env[PORT_VARIABLE] = url.port;
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}
