// PL-63's failures against a local stand-in for the API, which the Worker cannot be made to answer: a stream cut midway
// or shorter than its Content-Length, a stall, a 409 naming paths, an interrupt, the other error answers, and a stored
// login whose refresh is slow. Each leaves the directory as it was, or names its part when it cannot remove it. The
// Worker answers in e2e.test.ts.
import { chmod, readdir } from "node:fs/promises";
import type { RequestListener, ServerResponse } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Fetch } from "./api.ts";
import { Credentials, gate, StandIn, until, type Answer } from "./login-test-support.ts";
import { cli, ID, local, tempDir, TOKEN, type RunOptions } from "./test-support.ts";

const network: Fetch = (input, init) => fetch(input, init);
const TIMEOUTS = { requestMs: 5000, publishMs: 5000, fileMs: 5000, idleMs: 200 };
/** Permission checks do not hold for root, which the test that makes a directory read-only needs. */
const ROOT = process.getuid?.() === 0;
const ARCHIVE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const ZIP = { "Content-Type": "application/zip" };

/** The archive's first 600 bytes under a Content-Length of its whole length, ending cleanly. */
const shortBody: Fetch = async () =>
  new Response(ARCHIVE.subarray(0, 600), { headers: { ...ZIP, "Content-Length": String(ARCHIVE.byteLength) } });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the archive's answer: its headers with the whole length, then `sent` bytes of it. */
function start(response: ServerResponse, sent: number): void {
  response.writeHead(200, { ...ZIP, "Content-Length": String(ARCHIVE.byteLength) });
  response.write(ARCHIVE.subarray(0, sent));
}

/** `export` of version 1 into a new directory with `fetch`; the directory's entries afterwards. */
async function exportedWith(fetch: Fetch, env: Record<string, string>, options: RunOptions = {}) {
  const directory = await tempDir();
  const ran = await cli(["export", ID, "--version", "1", "-o", join(directory, "out.zip")], {
    env,
    fetch,
    timeouts: TIMEOUTS,
    ...options,
  });
  return { ...ran, left: await readdir(directory) };
}

/** `export` of version 1 into a new directory against `handler`; the directory's entries afterwards. */
async function exported(handler: RequestListener, options: RunOptions = {}) {
  return exportedWith(network, await local(handler), options);
}

describe("export against a stand-in", () => {
  it("fails on a stream cut midway, leaving nothing", async () => {
    const ran = await exported((_request, response) => {
      start(response, 300);
      setTimeout(() => response.socket?.destroy(), 50);
    });
    expect(ran).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the download broke off after 300 of 1000 bytes\n",
      left: [],
    });
  });

  it("fails on a stream that ends cleanly short of its Content-Length, leaving nothing", async () => {
    const directory = await tempDir();
    const ran = await cli(["export", ID, "--version", "1", "-o", join(directory, "out.zip")], {
      env: { ARTIFACTS_API_URL: "https://artifacts-api.example.com", ARTIFACTS_TOKEN: TOKEN },
      fetch: shortBody,
    });
    expect(ran).toMatchObject({
      status: 1,
      stderr: "artifacts: the download ended after 600 of the 1000 bytes the API announced\n",
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["before the headers", () => undefined],
    ["midway", (response: ServerResponse) => start(response, 300)],
  ])("fails when no byte arrives for the idle limit %s, leaving nothing", async (_when, answer) => {
    const ran = await exported((_request, response) => answer(response));
    expect(ran).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the download stalled: no bytes arrived for 0.2 s\n",
      left: [],
    });
  });

  it("has no limit on the whole download while bytes keep arriving", async () => {
    const ran = await exported(async (_request, response) => {
      start(response, 0);
      for (let at = 0; at < ARCHIVE.byteLength; at += 200) {
        await pause(100);
        response.write(ARCHIVE.subarray(at, at + 200));
      }
      response.end();
    });
    expect(ran).toMatchObject({ status: 0, stderr: "", left: ["out.zip"] });
    expect(ran.stdout).toMatch(/to .*out\.zip \(1000 bytes\)\n$/);
  });

  it("prints each path of a 409 not_extractable on its own line, escaped", async () => {
    const paths = ["a", "a\\b", "c\u0085d e\u0007"];
    const ran = await exported((_request, response) => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_extractable", message: "m", paths } }));
    });
    expect(ran).toEqual({
      status: 1,
      stdout: "",
      stderr:
        'artifacts: not_extractable: the version has paths that cannot be extracted as stored, since they hold "\\" ' +
        "or another path uses them as a directory; export refuses it:\n" +
        '  "a"\n' +
        '  "a\\\\b"\n' +
        '  "c\\u0085d\\u2028e\\u0007"\n',
      left: [],
    });
  });

  it("stops on an interrupt during the download, leaving nothing, and stops listening for one", async () => {
    let interrupt: (() => void) | undefined;
    let listening = 0;
    const ran = await exported(
      (_request, response) => {
        start(response, 300);
        setTimeout(() => interrupt?.(), 50);
      },
      {
        onInterrupt: (listener) => {
          interrupt = listener;
          listening++;
          return () => listening--;
        },
      },
    );
    expect(ran).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the export was interrupted\n",
      left: [],
    });
    expect(listening).toBe(0);
  });

  it.each([
    [
      404,
      { error: { code: "not_found", message: "m" } },
      `not_found: there is no such version of ${ID} to export; artifacts get ${ID} names the latest`,
    ],
    [
      503,
      { error: { code: "unavailable", message: "m" } },
      "unavailable: the API could not read the version's files; try again",
    ],
    [500, { error: { code: "internal", message: "the server failed" } }, "internal: the server failed"],
  ])("reports a %i in its own words, leaving nothing", async (status, body, message) => {
    const ran = await exported((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    expect(ran).toEqual({ status: 1, stdout: "", stderr: `artifacts: ${message}\n`, left: [] });
  });

  it("refuses an archive without a Content-Length, which could not tell a cut stream from a whole one", async () => {
    const ran = await exported((_request, response) => {
      response.writeHead(200, ZIP);
      response.end(ARCHIVE);
    });
    expect(ran).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "artifacts: the API answered without a Content-Length, so a cut archive could not be told from a whole one\n",
      left: [],
    });
  });

  it.skipIf(ROOT)("names its part when it cannot remove it, after the failure that ended the export", async () => {
    const directory = await tempDir();
    const env = await local((_request, response) => {
      start(response, 300);
      // The directory turns read-only during the download, so the part cannot be removed.
      void chmod(directory, 0o555);
    });
    try {
      const ran = await cli(["export", ID, "--version", "1", "-o", join(directory, "out.zip")], {
        env,
        fetch: network,
        timeouts: TIMEOUTS,
      });
      const [part = "", ...others] = await readdir(directory);
      expect([part, others]).toEqual([expect.stringMatching(/^out\.zip\.[0-9a-f]{12}\.part$/), []]);
      expect(ran).toEqual({
        status: 1,
        stdout: "",
        stderr:
          "artifacts: the download stalled: no bytes arrived for 0.2 s\n" +
          `  the partial download ${JSON.stringify(join(directory, part))} was left behind: it could not be removed ` +
          "(EACCES)\n",
      });
    } finally {
      await chmod(directory, 0o755);
    }
  });
});

/** A stored login whose access token has expired, so the next command refreshes it first. */
async function expiring(standIn: StandIn) {
  const credentials = await Credentials.create();
  const { client, tokens } = standIn.issue();
  await credentials.put(standIn.origin, { client, tokens, expires: Date.now() });
  return { credentials, tokens };
}

describe("export with a stored login", () => {
  const EXPORT = `/v1/artifacts/${ID}/versions/1/export`;
  const body = "archive bytes";
  /** The stand-in answers JSON: the archive is the JSON string, with its length. */
  const archive: Answer = {
    status: 200,
    body,
    headers: { ...ZIP, "Content-Length": String(Buffer.byteLength(JSON.stringify(body))) },
  };

  it("starts the idle limit when the request starts, not while a refresh resolves the credential", async () => {
    const standIn = await StandIn.start();
    const { credentials } = await expiring(standIn);
    standIn.override = async ({ path }) => {
      if (path === "/oauth/token") await pause(3 * TIMEOUTS.idleMs);
      return path === EXPORT ? archive : undefined;
    };
    const ran = await exportedWith(network, credentials.env(standIn));
    expect(ran).toMatchObject({ status: 0, stderr: "", left: ["out.zip"] });
    expect(standIn.requests).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/token refresh_token",
      `GET ${EXPORT}`,
    ]);
  });

  it("waits for a refresh an interrupt arrives during, then sends nothing and removes its part", async () => {
    const standIn = await StandIn.start();
    const { credentials, tokens } = await expiring(standIn);
    const refresh = gate();
    standIn.override = async ({ path }) => {
      if (path === "/oauth/token") await refresh.wait;
      return undefined;
    };
    let interrupt: (() => void) | undefined;
    let settled = false;
    const running = exportedWith(network, credentials.env(standIn), {
      onInterrupt: (listener) => {
        interrupt = listener;
        return () => undefined;
      },
    }).finally(() => {
      settled = true;
    });
    await until(() => standIn.requests.includes("POST /oauth/token refresh_token"));
    interrupt?.();
    // The refresh is still under way, so the export waits for it, and the idle limit does not count it.
    await pause(3 * TIMEOUTS.idleMs);
    expect(settled).toBe(false);
    refresh.open();
    expect(await running).toEqual({
      status: 1,
      stdout: "",
      stderr: "artifacts: the export was interrupted\n",
      left: [],
    });
    expect(standIn.requests.at(-1)).toBe("POST /oauth/token refresh_token");
    expect((await credentials.read())[standIn.origin]?.tokens?.access_token).not.toBe(tokens.access_token);
  });
});
