/**
 * The stored login (design.md section 9): `$XDG_CONFIG_HOME/artifacts/credentials.json` (`~/.config/artifacts/` when
 * unset), one entry per API origin with the client ID and, while signed in, the tokens and the access token's expiry.
 * The directory is `0700` and the file `0600`, written to a temporary file beside it and renamed over it, and the CLI
 * refuses either when another user can read or write it. Every change happens under the lock (lock.ts), after reading
 * the file again. POSIX only: no command reads a stored login on Windows.
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { Environment } from "./config.ts";
import { CliError, codeOf } from "./errors.ts";
import { withLock, type LockOptions } from "./lock.ts";

/** A signed-in login: its tokens and when the access token expires (ISO 8601). */
export type Tokens = { readonly access_token: string; readonly refresh_token: string; readonly expires_at: string };

/** One origin's entry: the client registered there, and the login while signed in. */
export type Entry = { readonly client_id: string; readonly tokens: Tokens | null };

export type Logins = Map<string, Entry>;

export type StoreBarriers = {
  /** A change has written its temporary file and is about to rename it over the stored one. */
  readonly beforeRename?: () => Promise<void>;
};

/** The file's contents while the lock is held: `write` stores `logins` as they are then. */
export type Locked = { readonly logins: Logins; readonly write: () => Promise<void> };

const FILE = "credentials.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function parseTokens(value: unknown): Tokens | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { access_token, refresh_token, expires_at } = value;
  if (!isText(access_token) || !isText(refresh_token) || !isText(expires_at)) return undefined;
  if (Number.isNaN(Date.parse(expires_at))) return undefined;
  return { access_token, refresh_token, expires_at };
}

function parseLogins(text: string): Logins | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.logins)) return undefined;
  const logins: Logins = new Map();
  for (const [origin, entry] of Object.entries(value.logins)) {
    if (!isRecord(entry) || !isText(entry.client_id)) return undefined;
    const tokens = parseTokens(entry.tokens);
    if (tokens === undefined) return undefined;
    logins.set(origin, { client_id: entry.client_id, tokens });
  }
  return logins;
}

/**
 * Refuses a file or directory that is not the owner's alone, naming it, as OpenSSH refuses a private key: owned by
 * another user, or with any group or other permission bit.
 */
function checkPrivate(path: string, stats: Stats, kind: "file" | "directory"): void {
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) throw new CliError(`${path} is not a ${kind}`);
  const uid = process.getuid?.();
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    const mode = kind === "file" ? "600" : "700";
    throw new CliError(
      `${path} can be read or written by another user, so the stored login is not used; ` +
        `make it the owner's alone (chmod ${mode} ${path})`,
    );
  }
}

/** The directory of the stored login, from the environment only; undefined when neither variable is set. */
export function storeDirectory(env: Environment): string | undefined {
  const config = env.XDG_CONFIG_HOME;
  // The XDG specification ignores a relative path.
  if (config !== undefined && isAbsolute(config)) return join(config, "artifacts");
  const home = env.HOME;
  if (home !== undefined && isAbsolute(home)) return join(home, ".config", "artifacts");
  return undefined;
}

export class Store {
  readonly directory: string;
  readonly file: string;
  readonly lockFile: string;
  readonly #lock: LockOptions;
  readonly #barriers: StoreBarriers;

  constructor(directory: string, lock: LockOptions, barriers: StoreBarriers = {}) {
    this.directory = directory;
    this.file = join(directory, FILE);
    this.lockFile = `${this.file}.lock`;
    this.#lock = lock;
    this.#barriers = barriers;
  }

  /** Every origin's entry; none when the directory or the file does not exist yet. */
  async read(): Promise<Logins> {
    let directory: Stats;
    try {
      directory = await stat(this.directory);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return new Map();
      throw error;
    }
    checkPrivate(this.directory, directory, "directory");
    let handle;
    try {
      handle = await open(this.file, "r");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return new Map();
      throw error;
    }
    try {
      checkPrivate(this.file, await handle.stat(), "file");
      const logins = parseLogins(await handle.readFile("utf8"));
      if (logins === undefined) {
        throw new CliError(`${this.file} is not a stored login this CLI can read; remove it and run artifacts login`);
      }
      return logins;
    } finally {
      await handle.close();
    }
  }

  /** Runs `body` under the lock with the file as it is then; `body` writes it back through `write`. */
  async withLock<T>(body: (locked: Locked) => Promise<T>): Promise<T> {
    await this.#ensureDirectory();
    return withLock(this.lockFile, this.#lock, async () => {
      const logins = await this.read();
      return body({ logins, write: () => this.#write(logins) });
    });
  }

  async #ensureDirectory(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // The mode passes through the umask; set it exactly on the directory this call made.
    if (created !== undefined) await chmod(this.directory, 0o700);
    checkPrivate(this.directory, await stat(this.directory), "directory");
  }

  async #write(logins: Logins): Promise<void> {
    const staged = join(this.directory, `${FILE}.${randomBytes(8).toString("hex")}.tmp`);
    const body = { logins: Object.fromEntries(logins) };
    const handle = await open(staged, "wx", 0o600);
    try {
      try {
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#barriers.beforeRename?.();
      await rename(staged, this.file);
    } catch (error) {
      await unlink(staged).catch(() => undefined);
      throw error;
    }
  }
}
