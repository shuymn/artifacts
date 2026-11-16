/**
 * The stored login's lock (design.md section 9, "The lock"): one exclusive file beside `credentials.json`. A process
 * takes it by linking a complete temporary file, which holds a random owner token, its process ID and the host name, to
 * the lock's name; the link fails while the lock exists. A waiter looks again every 100 ms for at most 75 s and never
 * takes the lock from a holder that may be alive. It removes only the lock of a holder on this host whose process is
 * gone, and only after linking that lock to a name made of the holder's token, which exactly one waiter can do.
 */
import { randomBytes } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

import { CliError, codeOf } from "./errors.ts";

export type LockOptions = {
  /** How long a waiter looks for the lock before it fails: longer than a refresh may take. */
  readonly waitMs: number;
  /** How often a waiter looks again. */
  readonly pollMs: number;
  /** Test barriers; each runs at its point and may hold the process there. */
  readonly barriers: LockBarriers;
};

export type LockBarriers = {
  /** A waiter found the holder gone and is about to link its lock to the `.dead` name. */
  readonly beforeRecover?: (owner: string) => Promise<void>;
};

export const LOCK_OPTIONS: LockOptions = { waitMs: 75_000, pollMs: 100, barriers: {} };

type Owner = { readonly token: string; readonly pid: number; readonly host: string };

const TOKEN = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(text: string): Owner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { token, pid, host } = value;
  if (typeof token !== "string" || !TOKEN.test(token)) return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof host !== "string") return undefined;
  return { token, pid, host };
}

async function readOwner(path: string): Promise<Owner | undefined> {
  try {
    return parseOwner(await readFile(path, "utf8"));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Whether process `pid` may be running: signal 0 reaches it, or it belongs to another user (`EPERM`). Only `ESRCH`
 * says it is gone. A reused process ID can make a gone holder look alive, never a live one look gone.
 */
function mayBeRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== "ESRCH";
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone, or a leftover the owner removes; nothing depends on it.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deadLink = (path: string, token: string) => `${path}.${token}.dead`;

/**
 * Removes the lock at `path` if `owner` held it and is gone. The waiter that links the lock to
 * `<path>.<owner token>.dead` first is the only one that may remove it: the link fails for every other waiter while it
 * exists. It removes the lock only if the link holds `owner`'s token, since the lock may have been released and taken
 * again since it was read; a gone holder releases nothing and no other waiter removes its lock, so the lock cannot
 * change between the link and the removal. A link that already exists is `blocked`: another waiter is removing the
 * lock, or one that stopped midway left the link, which only the owner may remove.
 */
async function recover(path: string, owner: Owner, options: LockOptions): Promise<"removed" | "kept" | "blocked"> {
  await options.barriers.beforeRecover?.(owner.token);
  const dead = deadLink(path, owner.token);
  try {
    await link(path, dead);
  } catch (error) {
    const code = codeOf(error);
    if (code === "EEXIST") return "blocked";
    if (code === "ENOENT") return "kept";
    throw error;
  }
  try {
    if ((await readOwner(dead))?.token !== owner.token) return "kept";
    await unlink(path);
    return "removed";
  } finally {
    await unlinkQuietly(dead);
  }
}

/** Runs `body` while holding the lock at `path`, and releases it on every exit. */
export async function withLock<T>(path: string, options: LockOptions, body: () => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString("hex");
  const host = hostname();
  const staged = `${path}.${token}.tmp`;
  await writeFile(staged, `${JSON.stringify({ token, pid: process.pid, host })}\n`, { flag: "wx", mode: 0o600 });
  try {
    const deadline = Date.now() + options.waitMs;
    for (;;) {
      try {
        await link(staged, path);
        break;
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      const owner = await readOwner(path);
      const gone = owner !== undefined && owner.host === host && !mayBeRunning(owner.pid);
      // The `.dead` link that kept this waiter from removing a gone holder's lock.
      let blocking: string | undefined;
      if (gone) {
        const recovery = await recover(path, owner, options);
        if (recovery === "removed") continue;
        if (recovery === "blocked") blocking = deadLink(path, owner.token);
      }
      if (Date.now() >= deadline) {
        if (blocking !== undefined) {
          throw new CliError(
            `the lock ${path} belongs to a process that is gone, and ${blocking}, left by an interrupted removal, ` +
              "keeps it; if no artifacts command is running, remove both files",
          );
        }
        throw new CliError(
          `another artifacts command holds the lock ${path}; if no artifacts command is running, remove that file`,
        );
      }
      await sleep(options.pollMs);
    }
  } finally {
    await unlinkQuietly(staged);
  }
  try {
    return await body();
  } finally {
    // Only a lock that still holds this process's token is its own.
    if ((await readOwner(path).catch(() => undefined))?.token === token) await unlinkQuietly(path);
  }
}
