// The runner of the scripts in this directory: exit statuses, the timeout, stopping every process of a command, and
// capturing its standard output.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunner } from "./runner.ts";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A runner of `node -e <script>`; the script sees the arguments in process.argv. */
const node = (script: string, timeoutMs = 10_000, graceMs = 10_000) =>
  createRunner({ command: process.execPath, prefix: ["-e", script], cwd: WORKER, timeoutMs, graceMs });

const runNode = (
  script: string,
  options: { timeoutMs?: number; graceMs?: number; signal?: AbortSignal; captureBytes?: number } = {},
) =>
  node(script, options.timeoutMs, options.graceMs)(
    [],
    options.signal ?? new AbortController().signal,
    options.captureBytes === undefined ? {} : { captureBytes: options.captureBytes },
  );

/** Whether `value` can name one process: a positive safe integer. */
const isPid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Whether the process has exited, allowing the system a moment to reap it. */
async function exited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("createRunner", () => {
  it("reports the exit status", async () => {
    expect(await runNode("process.exit(0)")).toEqual({ ok: true });
    expect(await runNode("process.exit(3)")).toEqual({ ok: false, reason: "exited with code 3" });
  });

  it("passes the arguments and runs in the Worker's directory", async () => {
    const runner = node("process.exit(process.argv[1] === 'x' && process.cwd() === process.argv[2] ? 0 : 1)");
    expect(await runner(["x", WORKER.replace(/\/$/, "")], new AbortController().signal)).toEqual({ ok: true });
  });

  it("reports a command that cannot start", async () => {
    const runner = createRunner({
      command: join(WORKER, "no-such-command"),
      cwd: WORKER,
      timeoutMs: 1000,
      graceMs: 1000,
    });
    expect(await runner([], new AbortController().signal)).toEqual({ ok: false, reason: "could not start (ENOENT)" });
  });

  it("stops a command that outlives the timeout", async () => {
    expect(await runNode("setInterval(() => {}, 1000)", { timeoutMs: 200 })).toEqual({
      ok: false,
      reason: "timed out after 0.2 s",
    });
  });

  it("kills a command that ignores SIGTERM after the grace period", async () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const started = Date.now();
    expect(await runNode(script, { timeoutMs: 200, graceMs: 300 })).toEqual({
      ok: false,
      reason: "timed out after 0.2 s",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  // wrangler's launcher runs wrangler in a second process; signalling the launcher alone would leave it running, reading
  // the configuration the deploy removes next.
  describe("a command that runs another process", () => {
    let dir: string;
    let pids: number[];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "deploy-runner-"));
      pids = [];
    });

    afterEach(() => {
      for (const pid of pids) {
        // Never 0 or a negative number, which would signal this process's group or every process it may signal.
        if (!isPid(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Code for a second process that publishes its PID to the file `pid`: written beside it, then renamed into place, so
     * the file never holds part of a PID.
     */
    function publishPid(): string {
      const file = JSON.stringify(join(dir, "pid"));
      return `const fs = require("fs"); fs.writeFileSync(${file} + ".new", String(process.pid)); fs.renameSync(${file} + ".new", ${file});`;
    }

    /**
     * Like wrangler's launcher, starts a second Node process, forwards SIGINT and SIGTERM to it, and exits with its
     * status; with `exitCode`, exits with it as soon as the second process runs instead. The second process ignores
     * SIGTERM, then publishes its PID.
     */
    function launcher(exitCode?: number): string {
      const second = `process.on("SIGTERM", () => {}); ${publishPid()} process.stdout.write("ready"); setInterval(() => {}, 1000);`;
      return `
        const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(second)}], { stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.once("data", () => { ${exitCode === undefined ? "" : `process.exit(${exitCode});`} });
        for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
        child.on("exit", (code, signal) => process.exit(code ?? 1));`;
    }

    /**
     * The second process's PID, once the file holds one. Anything but a positive integer is neither recorded nor
     * returned: `Number("")` is 0, and `process.kill(0)` signals this process's own group.
     */
    async function secondPid(): Promise<number> {
      for (let attempt = 0; attempt < 100; attempt++) {
        let text: string | undefined;
        try {
          text = readFileSync(join(dir, "pid"), "utf8");
        } catch {
          text = undefined;
        }
        const pid = text !== undefined && /^[1-9][0-9]*$/.test(text) ? Number(text) : undefined;
        if (pid !== undefined && isPid(pid)) {
          pids.push(pid);
          return pid;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the second process published no PID");
    }

    it("kills every process of a command that outlives the timeout", async () => {
      const result = runNode(launcher(), { timeoutMs: 1500, graceMs: 300 });
      const pid = await secondPid();
      expect(await result).toEqual({ ok: false, reason: "timed out after 1.5 s" });
      expect(await exited(pid)).toBe(true);
    });

    it("passes the signal it was stopped with to every process", async () => {
      const controller = new AbortController();
      const result = runNode(launcher(), { graceMs: 5000, signal: controller.signal });
      const pid = await secondPid();
      const stopped = Date.now();
      controller.abort("SIGINT");
      expect(await result).toEqual({ ok: false, reason: "was stopped" });
      // The second process ignores SIGTERM: it ended on the SIGINT, well before SIGKILL.
      expect(Date.now() - stopped).toBeLessThan(2500);
      expect(await exited(pid)).toBe(true);
    });

    it("reports the command's exit status and stops the processes it left", async () => {
      const result = runNode(launcher(3), { graceMs: 300 });
      const pid = await secondPid();
      expect(await result).toEqual({ ok: false, reason: "exited with code 3" });
      expect(await exited(pid)).toBe(true);
    });

    /**
     * Starts a second Node process that holds the command's standard output, in the command's group or, with
     * `ownGroup`, in a group of its own, and ignores SIGTERM with `ignoreTerm`; once the second process has written its
     * PID, the command prints "out" and exits with 0.
     */
    function holder(options: { ownGroup: boolean; ignoreTerm: boolean }): string {
      const file = JSON.stringify(join(dir, "pid"));
      const second = `${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} ${publishPid()} setInterval(() => {}, 1000);`;
      return `
        require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(second)}], { stdio: ["ignore", "inherit", "inherit"], detached: ${options.ownGroup} });
        const wait = setInterval(() => {
          if (!require("fs").existsSync(${file})) return;
          clearInterval(wait);
          process.stdout.write("out", () => process.exit(0));
        }, 10);`;
    }

    // "close" waits for the captured output's pipe, which the processes left behind still hold.
    it("returns the output once the processes the command left have stopped", async () => {
      const result = runNode(holder({ ownGroup: false, ignoreTerm: false }), { graceMs: 5000, captureBytes: 100 });
      const pid = await secondPid();
      const started = Date.now();
      expect(await result).toEqual({ ok: true, output: "out" });
      // Stopped by SIGTERM when the command exited, not by SIGKILL after the grace period.
      expect(Date.now() - started).toBeLessThan(2500);
      expect(await exited(pid)).toBe(true);
    });

    it("fails a capture whose left processes needed SIGKILL", async () => {
      const result = runNode(holder({ ownGroup: false, ignoreTerm: true }), { graceMs: 300, captureBytes: 100 });
      const pid = await secondPid();
      expect(await result).toEqual({ ok: false, reason: "printed output that could not be read" });
      expect(await exited(pid)).toBe(true);
    });

    it("stops waiting at the timeout for a pipe held outside the group", async () => {
      const result = runNode(holder({ ownGroup: true, ignoreTerm: true }), {
        timeoutMs: 1000,
        graceMs: 300,
        captureBytes: 100,
      });
      await secondPid();
      expect(await result).toEqual({ ok: false, reason: "timed out after 1 s" });
    });
  });

  describe("capturing standard output", () => {
    it("returns what the command printed, read as UTF-8", async () => {
      expect(await runNode("process.stdout.write('[\\u00e9]')", { captureBytes: 100 })).toEqual({
        ok: true,
        output: "[é]",
      });
      expect(await runNode("process.exit(0)", { captureBytes: 100 })).toEqual({ ok: true, output: "" });
    });

    it("accepts output at the bound and fails one byte past it", async () => {
      expect(await runNode("process.stdout.write('12345')", { captureBytes: 5 })).toEqual({
        ok: true,
        output: "12345",
      });
      expect(await runNode("process.stdout.write('123456')", { captureBytes: 5 })).toEqual({
        ok: false,
        reason: "printed more than 5 bytes",
      });
    });

    // A command blocked on a full pipe would run until the timeout.
    it("reads and drops output past the bound, so the command finishes", async () => {
      const script = "process.stdout.write('x'.repeat(8 * 1024 * 1024), () => process.exit(0))";
      expect(await runNode(script, { captureBytes: 10, timeoutMs: 5000 })).toEqual({
        ok: false,
        reason: "printed more than 10 bytes",
      });
    });

    it("reports a failed command's status, not its output", async () => {
      expect(await runNode("process.stdout.write('[]', () => process.exit(3))", { captureBytes: 100 })).toEqual({
        ok: false,
        reason: "exited with code 3",
      });
    });

    it("stops a command that outlives the timeout", async () => {
      expect(
        await runNode("process.stdout.write('['); setInterval(() => {}, 1000)", { timeoutMs: 200, captureBytes: 100 }),
      ).toEqual({ ok: false, reason: "timed out after 0.2 s" });
    });

    it("stops a command when the signal aborts", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort("SIGINT"), 100);
      expect(await runNode("setInterval(() => {}, 1000)", { signal: controller.signal, captureBytes: 100 })).toEqual({
        ok: false,
        reason: "was stopped",
      });
    });
  });

  it("stops a command when the signal aborts, and starts none after", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await runNode("setInterval(() => {}, 1000)", { signal: controller.signal })).toEqual({
      ok: false,
      reason: "was stopped",
    });
    expect(await runNode("process.exit(0)", { signal: controller.signal })).toEqual({
      ok: false,
      reason: "was not started",
    });
  });

  // wrangler skips its confirmation prompts without a terminal on stdin; declining the migrations prompt would exit 0
  // and let the deploy go on.
  it("gives the command no input", async () => {
    expect(
      await runNode("process.stdin.resume(); process.stdin.on('end', () => process.exit(0))", { timeoutMs: 5000 }),
    ).toEqual({
      ok: true,
    });
  });
});
