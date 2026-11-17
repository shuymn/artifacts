// PL-60 over real HTTP: the Worker in the local runtime (wrangler's test harness, with D1 and R2), as the CLI's
// end-to-end test runs it, on a localhost configuration. The export's response is read with `node:http`, so the test
// sees the headers as the runtime sent them: a `Content-Length` comes only from a body of known length, never from
// the header the Worker's code set on a stream (design.md section 8, "Export"). Info-ZIP's `unzip` extracts the archive.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

const WORKER = fileURLToPath(new URL("../", import.meta.url).href);
const APP_HOST = "app.localhost";
const API_HOST = "api.localhost";
const TOKEN = `art_${"e".repeat(32)}`;

let server: TestHarness;
let origin: URL;
const directories: string[] = [];

beforeAll(async () => {
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  server = createTestHarness({
    root: WORKER,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          APP_HOST,
          API_HOST,
          CONTENT_HOST_SUFFIX: "-art.localhost",
          PUBLIC_HOST_SUFFIX: "-pub.localhost",
          ARCHIVE_AFTER_DAYS: "30",
        },
        secrets: { API_TOKENS: JSON.stringify({ e2e: hash }) },
      },
    ],
  });
  origin = (await server.listen()).url;
  await server.getWorker().applyD1Migrations("DB");
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

type Answer = { status: number; headers: IncomingHttpHeaders; body: Buffer };

/** One request to the harness's address with `host` in its `Host` header, read whole as the socket delivers it. */
function send(method: string, host: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: origin.hostname, port: origin.port, method, path, headers: { ...headers, Host: host } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const FILES: Record<string, Uint8Array> = {
  "index.html": new TextEncoder().encode("<!doctype html><title>e2e</title>"),
  "assets/css/site.css": new TextEncoder().encode("body { color: #222 }"),
  "データ/表.csv": new TextEncoder().encode("a,b\n1,2\n"),
  "100%.txt": new TextEncoder().encode("percent"),
  "#frag.txt": new TextEncoder().encode("hash"),
  "what?.txt": new TextEncoder().encode("question"),
  "empty.txt": new Uint8Array(),
  "bytes.bin": Uint8Array.from({ length: 256 }, (_, i) => i),
};

async function publish(): Promise<string> {
  const form = new FormData();
  form.append("meta", JSON.stringify({ title: "e2e", files: Object.keys(FILES).map((path) => ({ path })) }));
  for (const bytes of Object.values(FILES)) form.append("file", new Blob([bytes]), "ignored.bin");
  // Node encodes the multipart body and its boundary; the harness's fetch takes them as bytes and headers.
  const encoded = new Request(`http://${API_HOST}/v1/artifacts`, { method: "POST", body: form });
  const response = await server.fetch(encoded.url, {
    method: "POST",
    headers: [...encoded.headers, ["Authorization", `Bearer ${TOKEN}`]],
    body: new Uint8Array(await encoded.arrayBuffer()),
  });
  expect(response.status).toBe(201);
  const json: unknown = await response.json();
  const artifact = typeof json === "object" && json !== null && "artifact" in json ? json.artifact : undefined;
  const id = typeof artifact === "object" && artifact !== null && "id" in artifact ? artifact.id : undefined;
  if (typeof id !== "string") throw new Error("the create answer names no artifact ID");
  return id;
}

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "artifacts-export-"));
  directories.push(path);
  return path;
}

/** Every file under `root`, by its path relative to it with `/`, and its bytes. */
async function tree(root: string): Promise<Record<string, Uint8Array>> {
  const found: Record<string, Uint8Array> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found[relative(root, path).split("\\").join("/")] = new Uint8Array(await readFile(path));
  }
  return found;
}

describe("PL-60: an export over HTTP", () => {
  it("sends the archive's length as Content-Length, and unzip reproduces the version's files", async () => {
    const id = await publish();
    const rest = await send("GET", API_HOST, `/v1/artifacts/${id}/versions/1/export`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(rest.status).toBe(200);
    expect(rest.headers["transfer-encoding"]).toBeUndefined();
    expect(rest.headers["content-length"]).toBe(String(rest.body.byteLength));
    expect(rest.headers["content-type"]).toBe("application/zip");
    expect(rest.headers["content-disposition"]).toBe(`attachment; filename="${id}-v1.zip"`);

    const download = await send("GET", APP_HOST, `/a/${id}/v/1/export`);
    expect(download.status).toBe(200);
    expect(download.headers["transfer-encoding"]).toBeUndefined();
    expect(download.headers["content-length"]).toBe(String(download.body.byteLength));
    expect(download.body.equals(rest.body)).toBe(true);

    const head = await send("HEAD", API_HOST, `/v1/artifacts/${id}/versions/1/export`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(head.headers["content-length"]).toBe(String(rest.body.byteLength));

    const directory = await tempDir();
    const archive = join(directory, `${id}-v1.zip`);
    await writeFile(archive, rest.body);
    const extracted = join(directory, "out");
    await promisify(execFile)("unzip", ["-q", archive, "-d", extracted]);
    expect(await tree(extracted)).toEqual(FILES);
  }, 60_000);
});
