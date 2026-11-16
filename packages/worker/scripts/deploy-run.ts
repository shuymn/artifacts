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
 * 2. `wrangler kv namespace list`, which must list each namespace ID: wrangler's documentation describes provisioning
 *    only for a binding without an ID and does not say what a wrong ID does, and a new, empty namespace would sign every
 *    OAuth client out.
 * 3. `wrangler d1 migrations apply --remote` for each database, on every deploy: the code of a commit expects the schema
 *    of that commit, and the command applies only the migrations not yet applied. Its confirmation prompt is skipped
 *    (no terminal on stdin), because declining it exits successfully and the deploy would go on.
 * 4. `wrangler deploy`.
 */
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
import { SIGNAL_STATUS, type Runner, type TerminationSignal } from "./runner.ts";

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

type Step = {
  readonly title: string;
  readonly args: readonly string[];
  readonly onFailure: string;
  /** A check of the command's standard output, captured up to `maxBytes`: the problem, or undefined when it passes. */
  readonly output?: { readonly maxBytes: number; readonly check: (output: string) => string | undefined };
};

/**
 * The most `wrangler kv namespace list` may print. It prints every namespace of the account as indented JSON, a few
 * hundred bytes each; this bound holds thousands.
 */
export const MAX_NAMESPACE_LIST_BYTES = 4 * 1024 * 1024;

/** Undefined when `wrangler kv namespace list` printed a list with a namespace whose ID is `id`; otherwise why not. */
function checkNamespaceList(output: string, id: string): string | undefined {
  let list: unknown;
  try {
    list = JSON.parse(output);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || !list.every((entry) => isRecord(entry) && typeof entry["id"] === "string")) {
    return "wrangler printed no JSON list of namespaces";
  }
  return list.some((entry: Json) => entry["id"] === id) ? undefined : "the account has no namespace with that ID";
}

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
    ...bindings(merged, "kv_namespaces", "id").map(({ binding, name: id }) => ({
      title: `checking that the KV namespace of ${binding} exists`,
      args: ["kv", "namespace", "list", "--config", config],
      onFailure: "Create the namespace, or correct its ID (docs/operations.md); nothing was changed.",
      output: { maxBytes: MAX_NAMESPACE_LIST_BYTES, check: (output: string) => checkNamespaceList(output, id) },
    })),
    // The hint names the database: wrangler.jsonc alone has no ID for the binding, and the merged configuration is gone.
    ...bindings(merged, "d1_databases", "database_name").map(({ binding, name }) => ({
      title: `applying the D1 migrations of ${binding}`,
      args: ["d1", "migrations", "apply", binding, "--remote", "--config", config],
      onFailure:
        `The Worker was not deployed; \`wrangler d1 execute ${name} --remote --command ` +
        `"SELECT name, applied_at FROM d1_migrations"\` lists the migrations applied.`,
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
    // The runner passes the signal on to the running command.
    controller.abort(signal);
  });
  let written = false;
  try {
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    written = true;
    for (const step of steps(merged, config)) {
      if (stoppedBy !== undefined) break;
      io.log(`deploy: ${step.title}`);
      const result = await io.run(
        step.args,
        controller.signal,
        step.output === undefined ? {} : { captureBytes: step.output.maxBytes },
      );
      if (stoppedBy !== undefined) break;
      if (!result.ok) {
        io.log(`deploy: ${step.title} failed: wrangler ${result.reason}. ${step.onFailure}`);
        return 1;
      }
      const problem = step.output?.check(result.output ?? "");
      if (problem !== undefined) {
        io.log(`deploy: ${step.title} failed: ${problem}. ${step.onFailure}`);
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
