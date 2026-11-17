/**
 * Helpers for the CLI's tests: temporary directories, `run` with its output captured, a local HTTP server, and the
 * API's JSON shapes.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach } from "vitest";

import type { Fetch, Timeouts } from "./api.ts";
import { run, type SignInOptions } from "./cli.ts";
import type { ExportOptions, OnInterrupt } from "./export.ts";

const created: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
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
  readonly platform?: NodeJS.Platform;
  /** Plays the browser; by default nothing opens, so a test never starts the system's opener. */
  readonly openBrowser?: (url: string) => void;
  readonly signIn?: Partial<SignInOptions>;
  /** Where `export` learns of an interrupt; by default none comes, and the test process's signals stay as they are. */
  readonly onInterrupt?: OnInterrupt;
  readonly link?: ExportOptions["link"];
  readonly create?: ExportOptions["create"];
};

const noInterrupt: OnInterrupt = () => () => undefined;

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
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    openBrowser: options.openBrowser ?? (() => undefined),
    ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
    onInterrupt: options.onInterrupt ?? noInterrupt,
    ...(options.link === undefined ? {} : { link: options.link }),
    ...(options.create === undefined ? {} : { create: options.create }),
  });
  return { status, stdout, stderr };
}

export const TOKEN = `art_${"t".repeat(32)}`;
export const ID = "a".repeat(26);

/**
 * A local HTTP server answering with `handler`, closed after the test, and the configuration that points the CLI at
 * it.
 */
export async function local(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  const { port } = address;
  return { ARTIFACTS_API_URL: `http://127.0.0.1:${port}`, ARTIFACTS_TOKEN: TOKEN };
}

/** An artifact as the API answers it. */
export function artifact(id: string, title = "t") {
  return {
    id,
    title,
    description: "",
    public: false,
    archived: false,
    archive: null,
    latest_version: 1,
    created_at: "2026-11-16T09:00:00.000Z",
    updated_at: "2026-11-16T09:00:00.000Z",
    url: `https://${id}-art.example.com/`,
    public_url: null,
    gallery_url: `https://artifacts.example.com/a/${id}`,
  };
}

/** Version 1 of the artifact `ID` holding `files`, as the API answers it. */
export function version(files: readonly { path: string; body: string | Uint8Array }[]) {
  return {
    number: 1,
    created_at: "2026-11-16T09:00:00.000Z",
    published_by: "codex",
    title: "t",
    description: "",
    file_count: files.length,
    total_bytes: 0,
    url: `https://${ID}-art.example.com/_v/1/`,
    files: files.map(({ path, body }) => ({
      path,
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      content_type: "text/plain; charset=utf-8",
    })),
  };
}
