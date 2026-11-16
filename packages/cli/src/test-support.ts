/** Helpers for the CLI's tests: temporary directories, and `run` with its output captured. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach } from "vitest";

import type { Fetch, Timeouts } from "./api.ts";
import { run } from "./cli.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A new empty directory, removed after the test. */
export async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
  created.push(path);
  return path;
}

/** A file tree: a string is a file's content; `{ link }` a symbolic link with that target. */
export type Tree = Readonly<Record<string, string | Uint8Array | { readonly link: string }>>;

/** Writes `tree` below `root`, creating directories as needed. */
export async function writeTree(root: string, tree: Tree): Promise<void> {
  for (const [path, entry] of Object.entries(tree)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    if (typeof entry === "object" && "link" in entry) await symlink(entry.link, full);
    else await writeFile(full, entry);
  }
}

export type Ran = { readonly status: number; readonly stdout: string; readonly stderr: string };

export type RunOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: Fetch;
  readonly timeouts?: Timeouts;
  readonly pageSize?: number;
};

const noNetwork: Fetch = () => Promise.reject(new Error("no fetch in this test"));

/** Runs the command with `argv` and captures what it prints. */
export async function cli(argv: readonly string[], options: RunOptions = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const status = await run(argv, {
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    fetch: options.fetch ?? noNetwork,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return { status, stdout, stderr };
}
