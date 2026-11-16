/**
 * What a publish sends (design.md section 9, "Directory mapping"): every regular file below a directory by its
 * relative POSIX path in NFC, names starting with `.` skipped, symbolic links followed only to targets inside the
 * directory; or a single HTML file as `index.html`. Paths are checked against section 6 before anything is sent.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import { CliError } from "./errors.ts";

/** Bounds of design.md section 6, in their units. */
export const LIMITS = {
  /** Files per version and per request. */
  files: 2000,
  /** A path: UTF-8 bytes. */
  pathBytes: 1024,
  /** The REST publish request body: bytes. */
  requestBytes: 32 * 1024 * 1024,
} as const;

export const ENTRY_FILE = "index.html";

/** Directories a walk enters at most: aliases can repeat a tree, and a tree without files never meets the file bound. */
const MAX_DIRECTORIES = 10_000;

/** One file to publish: its path in the version and the real file its bytes come from. */
export type LocalFile = { readonly path: string; readonly source: string; readonly size: number };

/** The reason a path cannot be published, or undefined when it can (design.md section 6, "Paths"). */
export function pathProblem(path: string): string | undefined {
  const [first] = path.split("/");
  if (first === "_v" || first === "cdn-cgi") return 'paths may not start with "_v/" or "cdn-cgi/"';
  if (Buffer.byteLength(path, "utf8") > LIMITS.pathBytes) return `paths are at most ${LIMITS.pathBytes} bytes of UTF-8`;
  return undefined;
}

class Walk {
  readonly #root: string;
  readonly #files = new Map<string, LocalFile>();
  #directories = 0;

  constructor(root: string) {
    this.#root = root;
  }

  get files(): LocalFile[] {
    return [...this.#files.values()];
  }

  #inside(real: string): boolean {
    return real === this.#root || real.startsWith(this.#root + sep);
  }

  #shown(real: string): string {
    return relative(this.#root, real) || ".";
  }

  #add(path: string, source: string, size: number): void {
    if (this.#files.has(path)) throw new CliError(`two files map to the path ${JSON.stringify(path)} in NFC`);
    if (this.#files.size >= LIMITS.files) throw new CliError(`more than ${LIMITS.files} files to publish`);
    this.#files.set(path, { path, source, size });
  }

  /** Walks the real directory `real`, published under `prefix`; `ancestors` are the real directories above it. */
  async directory(real: string, prefix: string, ancestors: ReadonlySet<string>): Promise<void> {
    if (++this.#directories > MAX_DIRECTORIES) throw new CliError(`more than ${MAX_DIRECTORIES} directories to walk`);
    const path = new Set([...ancestors, real]);
    const entries = await readdir(real, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const name = entry.name.normalize("NFC");
      const published = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(real, entry.name);
      if (entry.isSymbolicLink()) {
        await this.#link(full, published, path);
      } else if (entry.isDirectory()) {
        await this.directory(full, published, path);
      } else if (entry.isFile()) {
        this.#add(published, full, (await stat(full)).size);
      }
      // Sockets, FIFOs and devices are not regular files and are never opened.
    }
  }

  async #link(full: string, published: string, ancestors: ReadonlySet<string>): Promise<void> {
    const shown = JSON.stringify(published);
    let target: string;
    try {
      target = await realpath(full);
    } catch {
      throw new CliError(`the link ${shown} is broken`);
    }
    if (!this.#inside(target)) throw new CliError(`the link ${shown} leaves the directory`);
    const info = await stat(target);
    if (info.isDirectory()) {
      if (ancestors.has(target)) {
        throw new CliError(`the link ${shown} points to ${JSON.stringify(this.#shown(target))}, above itself (a loop)`);
      }
      await this.directory(target, published, ancestors);
    } else if (info.isFile()) {
      this.#add(published, target, info.size);
    }
  }
}

/**
 * The files to publish from `input`: a directory's files (section 9), or a single `.html`/`.htm` file as `index.html`.
 * The entry file, the file count and every path are checked here, before anything is sent.
 */
export async function localFiles(input: string): Promise<LocalFile[]> {
  let real: string;
  try {
    real = await realpath(input);
  } catch {
    throw new CliError(`cannot read ${JSON.stringify(input)}`);
  }
  const info = await stat(real);
  let files: LocalFile[];
  if (info.isDirectory()) {
    const walk = new Walk(real);
    await walk.directory(real, "", new Set());
    files = walk.files;
  } else if (info.isFile()) {
    const extension = extname(real).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") {
      throw new CliError("a single file must be an HTML file (.html or .htm); publish a directory with an index.html");
    }
    files = [{ path: ENTRY_FILE, source: real, size: info.size }];
  } else {
    throw new CliError(`${JSON.stringify(input)} is neither a directory nor a file`);
  }
  for (const file of files) {
    const problem = pathProblem(file.path);
    if (problem !== undefined) throw new CliError(`cannot publish ${JSON.stringify(file.path)}: ${problem}`);
  }
  if (!files.some((file) => file.path === ENTRY_FILE)) {
    throw new CliError("every version needs index.html at its root");
  }
  return files;
}

/** The hex SHA-256 of a file, read as a stream. */
export async function sha256File(source: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest("hex");
}

/** The SHA-256 of every file by path; a file reached through several paths is read once. */
export async function hashFiles(files: readonly LocalFile[]): Promise<Map<string, string>> {
  const bySource = new Map<string, Promise<string>>();
  const hashes = new Map<string, string>();
  for (const file of files) {
    let hash = bySource.get(file.source);
    if (hash === undefined) {
      hash = sha256File(file.source);
      bySource.set(file.source, hash);
    }
    hashes.set(file.path, await hash);
  }
  return hashes;
}
