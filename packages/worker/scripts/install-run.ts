/**
 * What scripts/install.ts does, with its process, files and command passed in so that install.test.ts can drive it.
 *
 * It installs the workspace's dependencies with the pnpm version that mise.lock pins, so that the build uses the pnpm of
 * the commit it builds and the dashboard holds no version: `npx --yes pnpm@<version> install --frozen-lockfile` at the
 * repository root. The build image's own pnpm (Corepack's default) never runs the install. It first checks that the Node
 * running it is the one .node-version asks for: pnpm only warns when Node is outside `engines.node`, and Workers Builds
 * falls back to its default Node when it finds no .node-version in the build's root directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNAL_STATUS, type Runner, type TerminationSignal } from "./runner.ts";

const LOCKFILE = "mise.lock";
const NODE_VERSION_FILE = ".node-version";

export type InstallIo = {
  /** The repository's root, where mise.lock and the pnpm workspace are and the command runs. */
  readonly repoDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly args: readonly string[];
  /** The version of the Node running the script, as `process.versions.node`. */
  readonly nodeVersion: string;
  /** Runs npx. */
  readonly run: Runner;
  /** Writes one line to standard error. */
  readonly log: (line: string) => void;
  /** Calls `listener` when the process receives a termination signal, until the returned function is called. */
  readonly onSignal: (listener: (signal: TerminationSignal) => void) => () => void;
};

export type PnpmVersion =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly problem: string };

const ENTRY = "[[tools.pnpm]]";
const EXACT = /^\d+\.\d+\.\d+$/;

/**
 * The one pnpm version in the text of mise.lock: the `version` of its `[[tools.pnpm]]` table. This runs before the
 * dependencies exist, so it reads only the lines mise writes for that table rather than parsing TOML in general, and
 * refuses anything else.
 */
export function lockedPnpmVersion(lockfile: string): PnpmVersion {
  const lines = lockfile.split(/\r?\n/).map((line) => line.trim());
  const starts = lines.flatMap((line, index) => (line === ENTRY ? [index] : []));
  if (starts.length === 0) return { ok: false, problem: `${LOCKFILE} has no ${ENTRY} entry` };
  if (starts.length > 1) return { ok: false, problem: `${LOCKFILE} pins more than one pnpm version; keep one` };
  const start = starts[0] ?? 0;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("["));
  const table = lines.slice(start + 1, end === -1 ? undefined : end);
  const versionLines = table.filter((line) => /^version\s*=/.test(line));
  if (versionLines.length !== 1) return { ok: false, problem: `the ${ENTRY} entry of ${LOCKFILE} has no version` };
  const value = /^version\s*=\s*"([^"]*)"$/.exec(versionLines[0] ?? "")?.[1];
  if (value === undefined || !EXACT.test(value)) {
    return { ok: false, problem: `the pnpm version in ${LOCKFILE} is not an exact version: ${versionLines[0]}` };
  }
  return { ok: true, version: value };
}

/**
 * Why Node `running` is not the Node of `wanted`, the content of .node-version (a major, `major.minor` or an exact
 * version, with or without a leading `v`), or undefined when it is.
 */
export function nodeVersionProblem(wanted: string, running: string): string | undefined {
  const version = wanted.trim();
  if (!/^v?\d+(\.\d+){0,2}$/.test(version)) {
    return `${NODE_VERSION_FILE} is not a Node version: ${JSON.stringify(version)}`;
  }
  const parts = version.replace(/^v/, "").split(".");
  const runningParts = running.split(".");
  if (parts.every((part, index) => Number(part) === Number(runningParts[index]))) return undefined;
  return (
    `this is Node ${running}, but ${NODE_VERSION_FILE} asks for ${version}; Workers Builds reads ${NODE_VERSION_FILE} ` +
    "from the build's root directory (docs/operations.md section 3)"
  );
}

/**
 * Workers Builds installs the dependencies with its own pnpm before the build command runs, unless the build variable
 * SKIP_DEPENDENCY_INSTALL is 1 or true; WORKERS_CI is 1 in its builds.
 */
function imageInstallProblem(env: InstallIo["env"]): string | undefined {
  if (env["WORKERS_CI"] !== "1") return undefined;
  const skip = env["SKIP_DEPENDENCY_INSTALL"];
  if (skip === "1" || skip === "true") return undefined;
  return (
    "SKIP_DEPENDENCY_INSTALL is not set to 1: Workers Builds has installed the dependencies with its own pnpm before " +
    "this command; set the build variable (docs/operations.md section 3)"
  );
}

/** Checks Node, reads the pnpm version and installs; returns the exit status. */
export async function install(io: InstallIo): Promise<number> {
  if (io.args.length > 0) {
    io.log("install: takes no arguments");
    return 1;
  }
  const problems: string[] = [];
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(join(io.repoDir, file), "utf8");
    } catch (error) {
      problems.push(
        `${file} cannot be read (${error instanceof Error && "code" in error ? String(error.code) : "error"})`,
      );
      return undefined;
    }
  };
  const wantedNode = read(NODE_VERSION_FILE);
  const node = wantedNode === undefined ? undefined : nodeVersionProblem(wantedNode, io.nodeVersion);
  if (node !== undefined) problems.push(node);
  const lockfile = read(LOCKFILE);
  const pnpm = lockfile === undefined ? undefined : lockedPnpmVersion(lockfile);
  if (pnpm !== undefined && !pnpm.ok) problems.push(pnpm.problem);
  const image = imageInstallProblem(io.env);
  if (image !== undefined) problems.push(image);
  if (pnpm === undefined || !pnpm.ok || problems.length > 0) {
    io.log("install: refused; nothing was run");
    for (const problem of problems) io.log(`  - ${problem}`);
    return 1;
  }

  const controller = new AbortController();
  let stoppedBy: TerminationSignal | undefined;
  const unsubscribe = io.onSignal((signal) => {
    stoppedBy ??= signal;
    // The runner passes the signal on to the running command.
    controller.abort(signal);
  });
  try {
    io.log(`install: pnpm ${pnpm.version} from ${LOCKFILE}`);
    const result = await io.run(["--yes", `pnpm@${pnpm.version}`, "install", "--frozen-lockfile"], controller.signal);
    if (stoppedBy !== undefined) {
      io.log(`install: stopped by ${stoppedBy}`);
      return SIGNAL_STATUS[stoppedBy];
    }
    if (!result.ok) {
      io.log(`install: npx pnpm@${pnpm.version} ${result.reason}`);
      return 1;
    }
    io.log("install: done");
    return 0;
  } finally {
    unsubscribe();
  }
}
