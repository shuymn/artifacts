/**
 * The browser tests' Worker: wrangler's test harness with D1 and R2, as the end-to-end test runs it, on a localhost
 * configuration, so Access is not verified (ACC-2) and every host is a name under `localhost`, which browsers resolve
 * to the loopback address and treat as secure, so they send Fetch Metadata. The hosts carry the harness's port, which
 * is known only once it listens; the configuration is then updated with it, which keeps the port.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

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
 * The `request.cf` of every request: `TIME_ZONE` and nothing else the Worker reads. Without it, Miniflare fetches the
 * caller's own from Cloudflare (or falls back to a placeholder of its own), so the zone would follow where the tests
 * run. Miniflare reads the file `CLOUDFLARE_CF_FETCH_PATH` names, and fetches again over a file older than 30 days, so
 * each run writes a new one and removes it at the end.
 */
async function pinCf(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "artifacts-cf-"));
  const path = join(directory, "cf.json");
  await writeFile(path, JSON.stringify({ timezone: TIME_ZONE }));
  process.env.CLOUDFLARE_CF_FETCH_PATH = path;
  return directory;
}

/**
 * Starts the Worker, gives the tests its port, and returns the teardown that stops it and removes the `cf` file; a
 * start that fails does the same.
 */
export default async function start(): Promise<() => Promise<void>> {
  const cf = await pinCf();
  const server = createTestHarness({ root: ROOT, workers: [worker("1")] });
  const stop = async () => {
    try {
      await server.close();
    } finally {
      await rm(cf, { recursive: true, force: true });
    }
  };
  try {
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
