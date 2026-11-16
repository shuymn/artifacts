/**
 * Runs a command for the scripts in this directory under a timeout, passing on the signals the script receives. It
 * imports nothing outside Node, so a script that runs before the dependencies are installed can use it.
 */
import { spawn } from "node:child_process";

export type RunResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/**
 * Runs the command with `args` until it exits or `signal` stops it; a termination signal as the abort reason is passed on
 * to the command.
 */
export type Runner = (args: readonly string[], signal: AbortSignal) => Promise<RunResult>;

export const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];
/** The exit status of a process stopped by the signal: 128 and the signal's number. */
export const SIGNAL_STATUS: Record<TerminationSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Calls `listener` when this process receives a termination signal, until the returned function is called. */
export function onTerminationSignal(listener: (signal: TerminationSignal) => void): () => void {
  for (const signal of TERMINATION_SIGNALS) process.on(signal, listener);
  return () => {
    for (const signal of TERMINATION_SIGNALS) process.off(signal, listener);
  };
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

/** How often a run checks whether the processes a command left behind have exited. */
const POLL_MS = 50;

function isTerminationSignal(value: unknown): value is TerminationSignal {
  return TERMINATION_SIGNALS.some((signal) => signal === value);
}

/**
 * Runs each command as the leader of a process group of its own, with its output on this process's output and no
 * terminal on its input. wrangler's launcher runs wrangler in a second Node process and forwards only SIGINT and SIGTERM
 * to it, so every signal goes to the whole group: SIGTERM to a command that outlives `timeoutMs`, the signal `signal`
 * was aborted with (the one this process received, else SIGTERM), and SIGKILL after `graceMs` to a group still running.
 * Processes left when the command exits are stopped the same way. The result is the command's own and comes once no
 * process of the group is left, or once SIGKILL was sent; every timer and listener is cleared then.
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
        detached: true,
      });
      /** Sends `name` to every process of the group; false when none is left. */
      const signalGroup = (name: NodeJS.Signals | 0): boolean => {
        if (child.pid === undefined) return false;
        try {
          process.kill(-child.pid, name);
          return true;
        } catch {
          return false;
        }
      };
      let timedOut = false;
      let killed = false;
      let exited: RunResult | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const stop = (name: NodeJS.Signals) => {
        if (killed || !signalGroup(name)) return;
        killTimer ??= setTimeout(() => {
          killed = true;
          signalGroup("SIGKILL");
          if (exited !== undefined) finish(exited);
        }, options.graceMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop("SIGTERM");
      }, options.timeoutMs);
      const onAbort = () => stop(isTerminationSignal(signal.reason) ? signal.reason : "SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearInterval(pollTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Only a failed start ends the run here; any other error leaves the child running until it closes.
        if (child.pid === undefined) finish({ ok: false, reason: `could not start (${error.code ?? "error"})` });
      });
      const outcome = (code: number | null, killedBy: NodeJS.Signals | null): RunResult => {
        if (timedOut) return { ok: false, reason: `timed out after ${options.timeoutMs / 1000} s` };
        if (signal.aborted) return { ok: false, reason: "was stopped" };
        if (code === 0) return { ok: true };
        if (code !== null) return { ok: false, reason: `exited with code ${code}` };
        return { ok: false, reason: `was stopped by ${killedBy ?? "a signal"}` };
      };
      child.on("close", (code, killedBy) => {
        clearTimeout(timer);
        const result = outcome(code, killedBy);
        exited = result;
        // A process the command left behind could still read the configuration the run removes next.
        if (killed || !signalGroup(0)) {
          finish(result);
          return;
        }
        stop("SIGTERM");
        pollTimer = setInterval(() => {
          if (!signalGroup(0)) finish(result);
        }, POLL_MS);
      });
    });
}
