/**
 * What scripts/deploy.ts does, with its process, files and wrangler passed in so that deploy.test.ts can drive it.
 *
 * The deployment values come from the build variable ARTIFACTS_DEPLOY_JSONC (Workers Builds) or from the gitignored
 * wrangler.deploy.jsonc (the owner's machine), never both. They are checked and merged into wrangler.jsonc
 * (deploy-config.ts); the merged configuration is written next to wrangler.jsonc, so every path in it resolves as in
 * wrangler.jsonc, and removed on every exit. Then, in order, each step stopping the rest when it fails:
 *
 * 1. `wrangler r2 bucket info` for each bucket: `wrangler deploy` creates a bucket that does not exist, so a mistyped
 *    name would bind a new, empty bucket.
 * 2. `wrangler d1 migrations apply --remote` for each database, on every deploy: the code of a commit expects the schema
 *    of that commit, and the command applies only the migrations not yet applied. Its confirmation prompt is skipped
 *    (no terminal on stdin), because declining it exits successfully and the deploy would go on.
 * 3. `wrangler deploy`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkDeployValues,
  DEPLOY_VALUES_FILE,
  DEPLOY_VALUES_VARIABLE,
  isRecord,
  parseJsonc,
  type Json,
} from "./deploy-config.ts";

export type RunResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/** Runs wrangler with `args` in the Worker's directory until it exits or `signal` stops it. */
export type Runner = (args: readonly string[], signal: AbortSignal) => Promise<RunResult>;

export const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];
/** The exit status of a process stopped by the signal: 128 and the signal's number. */
const SIGNAL_STATUS: Record<TerminationSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export type DeployIo = {
  /** The directory of wrangler.jsonc, where wrangler runs. */
  readonly workerDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly args: readonly string[];
  readonly run: Runner;
  /** Writes one line to standard error. */
  readonly log: (line: string) => void;
  /** Calls `listener` when the process receives a termination signal, until the returned function is called. */
  readonly onSignal: (listener: (signal: TerminationSignal) => void) => () => void;
};

type Step = { readonly title: string; readonly args: readonly string[]; readonly onFailure: string };

type Read = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

function readJsonc(text: string, source: string): Read {
  const parsed = parseJsonc(text);
  return parsed.ok ? parsed : { ok: false, problem: `${source} ${parsed.problem}` };
}

/** The deployment values from the build variable or the file, never both, and which of the two they came from. */
function readValues(
  io: DeployIo,
): (Read & { readonly ok: true; readonly source: string }) | (Read & { readonly ok: false }) {
  const fromEnv = io.env[DEPLOY_VALUES_VARIABLE];
  let fromFile: string | undefined;
  try {
    fromFile = readFileSync(join(io.workerDir, DEPLOY_VALUES_FILE), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return { ok: false, problem: `${DEPLOY_VALUES_FILE} cannot be read` };
    }
  }
  if (fromEnv !== undefined && fromFile !== undefined) {
    return { ok: false, problem: `both ${DEPLOY_VALUES_VARIABLE} and ${DEPLOY_VALUES_FILE} are set; keep one` };
  }
  const [text, source] = fromEnv !== undefined ? [fromEnv, DEPLOY_VALUES_VARIABLE] : [fromFile, DEPLOY_VALUES_FILE];
  if (text !== undefined) {
    const read = readJsonc(text, source);
    return read.ok ? { ...read, source } : read;
  }
  return {
    ok: false,
    problem:
      `${DEPLOY_VALUES_FILE} is missing and ${DEPLOY_VALUES_VARIABLE} is not set: copy ` +
      `wrangler.deploy.example.jsonc to ${DEPLOY_VALUES_FILE}, or set the build variable on Workers Builds`,
  };
}

function bindings(merged: Json, key: string, field: string): { binding: string; name: string }[] {
  const entries = merged[key];
  return (Array.isArray(entries) ? (entries as unknown[]) : []).flatMap((entry) =>
    isRecord(entry) && typeof entry["binding"] === "string" && typeof entry[field] === "string"
      ? [{ binding: entry["binding"], name: entry[field] }]
      : [],
  );
}

function steps(merged: Json, config: string): Step[] {
  return [
    ...bindings(merged, "r2_buckets", "bucket_name").map(({ binding, name }) => ({
      title: `checking that the R2 bucket of ${binding} exists`,
      args: ["r2", "bucket", "info", name, "--config", config],
      onFailure: "Create the bucket first (docs/operations.md); nothing was changed.",
    })),
    ...bindings(merged, "d1_databases", "database_id").map(({ binding }) => ({
      title: `applying the D1 migrations of ${binding}`,
      args: ["d1", "migrations", "apply", binding, "--remote", "--config", config],
      onFailure: `The Worker was not deployed; \`wrangler d1 migrations list ${binding} --remote\` shows what is applied.`,
    })),
    {
      title: "deploying the Worker",
      args: ["deploy", "--config", config],
      onFailure: "`wrangler deployments list` shows which version is active.",
    },
  ];
}

/** Checks, merges and deploys; returns the exit status. */
export async function deploy(io: DeployIo): Promise<number> {
  if (io.args.length > 0) {
    io.log("deploy: takes no arguments");
    return 1;
  }
  const base = readJsonc(readFileSync(join(io.workerDir, "wrangler.jsonc"), "utf8"), "wrangler.jsonc");
  const values = readValues(io);
  const problems = [base, values].flatMap((read) => (read.ok ? [] : [read.problem]));
  if (base.ok && values.ok) {
    const check = checkDeployValues(isRecord(base.value) ? base.value : {}, values.value);
    if (check.ok) return run(io, check.merged);
    problems.push(...check.problems.map((problem) => `${values.source}: ${problem}`));
  }
  io.log("deploy: refused; nothing was run");
  for (const problem of problems) io.log(`  - ${problem}`);
  return 1;
}

async function run(io: DeployIo, merged: Json): Promise<number> {
  // Next to wrangler.jsonc, so that `main`, `migrations_dir` and the module rules resolve as they do there. The name is
  // new for each run and the file is created exclusively, so only a file this run wrote is removed.
  const config = `.wrangler-deploy-${randomBytes(8).toString("hex")}.json`;
  const path = join(io.workerDir, config);
  const controller = new AbortController();
  let stoppedBy: TerminationSignal | undefined;
  const unsubscribe = io.onSignal((signal) => {
    stoppedBy ??= signal;
    controller.abort();
  });
  let written = false;
  try {
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    written = true;
    for (const step of steps(merged, config)) {
      if (stoppedBy !== undefined) break;
      io.log(`deploy: ${step.title}`);
      const result = await io.run(step.args, controller.signal);
      if (stoppedBy !== undefined) break;
      if (!result.ok) {
        io.log(`deploy: ${step.title} failed: wrangler ${result.reason}. ${step.onFailure}`);
        return 1;
      }
    }
    if (stoppedBy !== undefined) {
      io.log(`deploy: stopped by ${stoppedBy}`);
      return SIGNAL_STATUS[stoppedBy];
    }
    io.log("deploy: done");
    return 0;
  } finally {
    if (written) rmSync(path, { force: true });
    unsubscribe();
  }
}

export type RunnerOptions = {
  readonly command: string;
  readonly prefix?: readonly string[];
  readonly cwd: string;
  /** How long one command may run before it is stopped. */
  readonly timeoutMs: number;
  /** How long a stopped command has to exit after SIGTERM before SIGKILL. */
  readonly graceMs: number;
};

/**
 * Runs each command as a child process with its output on this process's output and no terminal on its input. A
 * command that outlives `timeoutMs`, or whose signal aborts, gets SIGTERM and then SIGKILL after `graceMs`; the result
 * comes when the child has exited, and every timer and listener is cleared then.
 */
export function createRunner(options: RunnerOptions): Runner {
  return (args, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ ok: false, reason: "was not started" });
        return;
      }
      const child = spawn(options.command, [...(options.prefix ?? []), ...args], {
        cwd: options.cwd,
        stdio: ["ignore", "inherit", "inherit"],
      });
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), options.graceMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      signal.addEventListener("abort", stop, { once: true });
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
        resolve(result);
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Only a failed start ends the run here; any other error leaves the child running until it closes.
        if (child.pid === undefined) finish({ ok: false, reason: `could not start (${error.code ?? "error"})` });
      });
      child.on("close", (code, killedBy) => {
        if (timedOut) finish({ ok: false, reason: `timed out after ${options.timeoutMs / 1000} s` });
        else if (signal.aborted) finish({ ok: false, reason: "was stopped" });
        else if (code === 0) finish({ ok: true });
        else if (code !== null) finish({ ok: false, reason: `exited with code ${code}` });
        else finish({ ok: false, reason: `was stopped by ${killedBy ?? "a signal"}` });
      });
    });
}
