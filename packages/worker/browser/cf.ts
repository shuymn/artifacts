/**
 * The browser tests' `request.cf`: a file Miniflare reads in place of the caller's own, which it would otherwise fetch
 * from Cloudflare (or replace with a placeholder of its own), so the zone the Worker sees would follow where the tests
 * run.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The variable naming the file Miniflare reads `request.cf` from. */
export const CF_PATH_VARIABLE = "CLOUDFLARE_CF_FETCH_PATH";

/** The file operations `pinCf` uses; tests pass failing ones. */
export type CfFiles = {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
};

const FILES: CfFiles = { mkdtemp, writeFile, rm };

/**
 * Points Miniflare at a new file whose `request.cf` holds `zone` and nothing else, and returns what undoes it: the
 * variable gets its previous value back, or is deleted if it had none, so a later Miniflare in the process does not
 * look for the removed file and fetch instead, and the directory is removed. Miniflare fetches again over a file older
 * than 30 days, so each run writes a new one. A failed write undoes the same before it throws.
 */
export async function pinCf(
  zone: string,
  env: NodeJS.ProcessEnv = process.env,
  files: CfFiles = FILES,
): Promise<() => Promise<void>> {
  const previous = env[CF_PATH_VARIABLE];
  const directory = await files.mkdtemp(join(tmpdir(), "artifacts-cf-"));
  const unpin = async () => {
    if (previous === undefined) delete env[CF_PATH_VARIABLE];
    else env[CF_PATH_VARIABLE] = previous;
    await files.rm(directory, { recursive: true, force: true });
  };
  try {
    const path = join(directory, "cf.json");
    await files.writeFile(path, JSON.stringify({ timezone: zone }));
    env[CF_PATH_VARIABLE] = path;
  } catch (error) {
    await unpin();
    throw error;
  }
  return unpin;
}
