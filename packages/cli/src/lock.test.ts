// PL-50: CLI runs that change the stored login at once, held at barriers, against the local stand-in
// (login-test-support.ts). Runs in this process share its process ID, so each one's lock looks alive to the others, as
// a live process's does; a gone holder's lock is written with the ID of a process that has exited. One test runs two
// real processes of the CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { Fetch } from "./api.ts";
import type { SignInOptions } from "./cli.ts";
import { Credentials, exists, gate, StandIn, until } from "./login-test-support.ts";
import { cli, type Ran } from "./test-support.ts";

const MAIN = fileURLToPath(new URL("main.ts", import.meta.url));
const fetch: Fetch = (input, init) => globalThis.fetch(input, init);
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** A stand-in and a stored login whose access token has expired, so the next command refreshes it first. */
async function expired() {
  const standIn = await StandIn.start();
  const credentials = await Credentials.create();
  const issued = standIn.issue();
  await credentials.put(standIn.origin, { client: issued.client, tokens: issued.tokens, expires: Date.now() });
  return { standIn, credentials, env: credentials.env(standIn), issued, lock: `${credentials.file}.lock` };
}

function list(env: Record<string, string>, signIn: Partial<SignInOptions> = {}): Promise<Ran> {
  return cli(["list"], { env, fetch, signIn: { lockPollMs: 10, ...signIn } });
}

/** A barrier every one of `count` runs reaches before any goes on. */
function meeting(count: number): () => Promise<void> {
  const all = gate();
  let arrived = 0;
  return async () => {
    if (++arrived === count) all.open();
    await all.wait;
  };
}

/** The ID of a process that ran and has exited. */
async function gonePid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

const lockOf = (token: string, pid: number, host = hostname()) => `${JSON.stringify({ token, pid, host })}\n`;
const OWNER = "0".repeat(32);

describe("PL-50: refreshes at once", () => {
  it("two runs with an expired access token refresh once and both succeed", async () => {
    const { standIn, credentials, env } = await expired();
    const both = meeting(2);
    const signIn = { barriers: { beforeRefreshLock: both } };
    const [first, second] = await Promise.all([list(env, signIn), list(env, signIn)]);
    expect([first.status, second.status]).toEqual([0, 0]);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
    expect(standIn.count("GET /v1/artifacts")).toBe(2);
    const stored = (await credentials.read())[standIn.origin]?.tokens;
    expect(standIn.access.has(stored?.access_token ?? "")).toBe(true);
  });

  it("two CLI processes with an expired access token refresh once and both succeed", async () => {
    const { standIn, env } = await expired();
    const metadata = "GET /.well-known/oauth-authorization-server";
    // The refresh is answered once both processes have read the expired token and asked for the metadata.
    standIn.override = async ({ path }) => {
      if (path === "/oauth/token") await until(() => standIn.count(metadata) === 2);
      return undefined;
    };
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [MAIN, "list"], {
          env: { PATH: process.env.PATH ?? "", ...env },
          stdio: "ignore",
        });
        children.push(child);
        child.on("error", reject);
        child.on("close", resolve);
      });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(standIn.count(metadata)).toBe(2);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
  });

  it("a refresh delayed under its timeout makes the waiter use the tokens it stored", async () => {
    const { standIn, env } = await expired();
    const arrived = gate();
    standIn.override = async ({ path }) => {
      if (path !== "/oauth/token") return undefined;
      arrived.open();
      // 20 s of 30 s, scaled.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return undefined;
    };
    const timing = { requestMs: 600, lockWaitMs: 1500 };
    const first = list(env, timing);
    await arrived.wait;
    const second = await list(env, timing);
    expect(second.status).toBe(0);
    expect((await first).status).toBe(0);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
  });

  it("a refresh delayed past its timeout is aborted with the lock released and the file as it was", async () => {
    const { standIn, credentials, env, lock } = await expired();
    const before = await readFile(credentials.file, "utf8");
    standIn.override = async ({ path }) => {
      if (path === "/oauth/token") await new Promise((resolve) => setTimeout(resolve, 1000));
      return undefined;
    };
    const ran = await list(env, { requestMs: 300 });
    expect(ran).toMatchObject({ status: 1, stderr: "artifacts: the refresh got no answer within 0.3 s\n" });
    expect(await exists(lock)).toBe(false);
    expect(await readFile(credentials.file, "utf8")).toBe(before);
  });
});

describe("PL-50: a holder that may be alive", () => {
  it("keeps the lock while stopped before its rename: the waiter fails naming it, and the holder then writes", async () => {
    const { standIn, credentials, env, lock } = await expired();
    const stopped = gate();
    const resume = gate();
    const holder = list(env, {
      barriers: {
        beforeRename: async () => {
          stopped.open();
          await resume.wait;
        },
      },
    });
    await stopped.wait;
    const held = await readFile(lock, "utf8");
    // The waiter reads the expired token too, and runs out its wait (75 s, scaled).
    const waiter = await list(env, { lockWaitMs: 300 });
    expect(waiter).toMatchObject({
      status: 1,
      stderr: `artifacts: another artifacts command holds the lock ${lock}; if no artifacts command is running, remove that file\n`,
    });
    expect(await readFile(lock, "utf8")).toBe(held);
    resume.open();
    expect((await holder).status).toBe(0);
    expect(await exists(lock)).toBe(false);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
    const stored = (await credentials.read())[standIn.origin]?.tokens;
    expect(standIn.access.has(stored?.access_token ?? "")).toBe(true);
  });

  it.each<[string, () => Promise<string>]>([
    [
      "a running process",
      async () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        children.push(child);
        await once(child, "spawn");
        return lockOf(OWNER, child.pid ?? 0);
      },
    ],
    ["another user's process (EPERM)", async () => lockOf(OWNER, 1)],
    ["a gone process on another host", async () => lockOf(OWNER, await gonePid(), "another-host.example.com")],
    // A reused process ID makes a gone holder look alive: this test process's ID stands for one.
    ["a process ID now reused", async () => lockOf(OWNER, process.pid)],
    ["a lock it cannot read", async () => "not a lock\n"],
  ])("never removes the lock of %s", async (_name, content) => {
    const { standIn, env, lock } = await expired();
    const written = await content();
    await writeFile(lock, written);
    const ran = await list(env, { lockWaitMs: 300 });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`holds the lock ${lock}`);
    expect(await readFile(lock, "utf8")).toBe(written);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(0);
  });
});

describe("PL-50: a gone holder's lock", () => {
  it("is removed by the waiter, which then refreshes", async () => {
    const { standIn, env, lock } = await expired();
    await writeFile(lock, lockOf(OWNER, await gonePid()));
    expect((await list(env)).status).toBe(0);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
    expect(await exists(lock)).toBe(false);
  });

  it("is removed by exactly one of two waiters at once; the other never removes the lock taken after it", async () => {
    const { standIn, env, lock } = await expired();
    await writeFile(lock, lockOf(OWNER, await gonePid()));
    const both = meeting(2);
    const second = gate();
    let recoveries = 0;
    const refreshing = gate();
    const release = gate();
    standIn.override = async ({ path }) => {
      if (path !== "/oauth/token") return undefined;
      refreshing.open();
      await release.wait;
      return undefined;
    };
    const waiter = (late: boolean) =>
      list(env, {
        barriers: {
          beforeRecover: async () => {
            recoveries += 1;
            await both();
            if (late) await second.wait;
          },
        },
      });
    const first = waiter(false);
    const other = waiter(true);
    // The first waiter removed the gone lock, took its own and is refreshing under it.
    await refreshing.wait;
    const taken = await readFile(lock, "utf8");
    expect(taken).not.toContain(OWNER);
    // The second, which also found the gone holder, now tries to recover with what it read.
    second.open();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(lock, "utf8")).toBe(taken);
    expect(recoveries).toBe(2);
    release.open();
    expect([(await first).status, (await other).status]).toEqual([0, 0]);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
    expect(await exists(lock)).toBe(false);
  });
});

describe("PL-50: login and logout racing a refresh", () => {
  it("a refresh that waited while login stored new tokens uses them and does not refresh", async () => {
    const { standIn, credentials, env } = await expired();
    const read = gate();
    const go = gate();
    const refresh = list(env, {
      barriers: {
        beforeRefreshLock: async () => {
          read.open();
          await go.wait;
        },
      },
    });
    await read.wait;
    const signedIn = await cli(["login"], { env, fetch, openBrowser: (url) => standIn.approve(url) });
    expect(signedIn.status).toBe(0);
    const stored = (await credentials.read())[standIn.origin]?.tokens;
    go.open();
    expect((await refresh).status).toBe(0);
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(0);
    expect((await credentials.read())[standIn.origin]?.tokens).toEqual(stored);
  });

  it("a refresh that waited while logout removed the login stops and does not write it back", async () => {
    const { standIn, credentials, env } = await expired();
    const read = gate();
    const go = gate();
    const refresh = list(env, {
      barriers: {
        beforeRefreshLock: async () => {
          read.open();
          await go.wait;
        },
      },
    });
    await read.wait;
    // Logout refreshes its own expired token first, then revokes.
    const signedOut = await cli(["logout"], { env, fetch });
    expect(signedOut).toMatchObject({ status: 0, stdout: `signed out of ${standIn.origin}\n` });
    go.open();
    const ran = await refresh;
    expect(ran).toMatchObject({
      status: 1,
      stderr: `artifacts: the stored login for ${standIn.origin} was removed; sign in with artifacts login\n`,
    });
    expect((await credentials.read())[standIn.origin]?.tokens).toBeNull();
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
  });
});

describe("an access token that expires within a minute", () => {
  it("is refreshed before the request; one that expires later is not", async () => {
    const standIn = await StandIn.start();
    const credentials = await Credentials.create();
    const env = credentials.env(standIn);
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens, expires: Date.now() + 70_000 });
    expect((await list(env)).status).toBe(0);
    expect(standIn.requests).toEqual(["GET /v1/artifacts"]);
    await credentials.put(standIn.origin, { client, tokens, expires: Date.now() + 50_000 });
    expect((await list(env)).status).toBe(0);
    expect(standIn.requests.slice(1)).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/token refresh_token",
      "GET /v1/artifacts",
    ]);
  });
});

describe("PL-50: a 401", () => {
  it("is followed by exactly one refresh request and one replay of the request", async () => {
    const standIn = await StandIn.start();
    const credentials = await Credentials.create();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    const env = credentials.env(standIn);
    standIn.override = ({ path }) =>
      path === "/v1/artifacts" ? { status: 401, body: { error: { code: "unauthorized", message: "no" } } } : undefined;
    const ran = await list(env);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("(check ARTIFACTS_TOKEN, or sign in again with artifacts login)");
    expect(standIn.requests).toEqual([
      "GET /v1/artifacts",
      "GET /.well-known/oauth-authorization-server",
      "POST /oauth/token refresh_token",
      "GET /v1/artifacts",
    ]);
  });

  it("whose replay succeeds completes the command with the refreshed token", async () => {
    const standIn = await StandIn.start();
    const credentials = await Credentials.create();
    const { client, tokens } = standIn.issue();
    await credentials.put(standIn.origin, { client, tokens });
    // The server no longer takes the access token, though the file says it is valid for an hour.
    standIn.access.delete(tokens.access_token);
    const ran = await list(credentials.env(standIn));
    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(standIn.count("POST /oauth/token refresh_token")).toBe(1);
    expect(standIn.count("GET /v1/artifacts")).toBe(2);
  });

  it("to ARTIFACTS_TOKEN is not retried", async () => {
    const standIn = await StandIn.start();
    const ran = await cli(["list"], { env: { ARTIFACTS_API_URL: standIn.origin, ARTIFACTS_TOKEN: "art_x" }, fetch });
    expect(ran.status).toBe(1);
    expect(standIn.requests).toEqual(["GET /v1/artifacts"]);
  });
});
