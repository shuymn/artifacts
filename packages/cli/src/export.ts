/**
 * `export` (design.md section 9): writes a version's archive (section 8, "Export") to a file without replacing
 * anything. The archive goes to `<file>.<random>.part` beside the target, created exclusively; only once the stream
 * has ended with the length `Content-Length` announced is the part linked to the target, which fails when the target
 * exists, and removed. Where the file system makes no hard links, the target is created exclusively and the part's
 * bytes copied into it. On a failure the command removes what it created when it can, and names what it cannot.
 */
import { randomBytes } from "node:crypto";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";

import type { Api, IdleLimit } from "./api.ts";
import { CliError, codeOf, LeftBehind } from "./errors.ts";

/** Subscribes a listener to the owner's interrupt and answers its unsubscribe. */
export type OnInterrupt = (listener: () => void) => () => void;

/** This process's interrupts: SIGINT, and SIGTERM where the platform sends it. */
export const processInterrupts: OnInterrupt = (listener) => {
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.on(signal, listener);
  return () => {
    for (const signal of signals) process.off(signal, listener);
  };
};

export type ExportOptions = {
  /** How long the download may wait on the network without a byte. */
  readonly idleMs: number;
  readonly onInterrupt: OnInterrupt;
  /** Makes a hard link; `node:fs` `link` outside tests. */
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
};

export const EXPORT_LINK: ExportOptions["link"] = link;

export type Exported = {
  readonly version: number;
  readonly file: string;
  readonly bytes: number;
  /** For the owner when the archive is in place but the part could not be removed. */
  readonly note: string | undefined;
};

const PART = "the partial download";

/** A file system call on `shown` failed; only its error code is kept. */
const cannotWrite = (shown: string, error: unknown) =>
  new CliError(`cannot write ${shown} (${codeOf(error) ?? "error"})`);

/** Refuses a target that exists in any form, a dangling symbolic link included. */
async function refuseExisting(target: string): Promise<void> {
  const shown = JSON.stringify(target);
  try {
    await lstat(target);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw new CliError(`cannot use ${shown} as the archive's file (${codeOf(error) ?? "error"})`);
  }
  throw new CliError(`${shown} exists; export does not replace it, so name another file with -o`);
}

/** Removes a file this command made; when it stays, a note naming it. A file already gone is not left behind. */
async function removeOwn(path: string, what: string): Promise<string | undefined> {
  try {
    await unlink(path);
    return undefined;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    return `${what} ${JSON.stringify(path)} was left behind: it could not be removed (${codeOf(error) ?? "error"})`;
  }
}

/** `error` with one more file it left behind. */
function leaving(error: unknown, note: string): LeftBehind {
  return error instanceof LeftBehind
    ? new LeftBehind(error.failure, [...error.notes, note])
    : new LeftBehind(error, [note]);
}

/**
 * The download's idle limit, which an interrupt shares: the signal aborts with the limit's reason or the interrupt's.
 * The limit runs only while the request or a read waits on the network.
 */
class Idle implements IdleLimit {
  readonly #controller = new AbortController();
  readonly #ms: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal = this.#controller.signal;
  readonly aborted: Promise<never>;

  constructor(ms: number) {
    this.#ms = ms;
    this.aborted = new Promise<never>((_, reject) => {
      this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
    });
    // Nothing may be waiting on it when an interrupt comes after the download: that is no unhandled rejection.
    this.aborted.catch(() => undefined);
  }

  start(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.abort(new CliError(`the download stalled: no bytes arrived for ${this.#ms / 1000} s`));
    }, this.#ms);
  }

  stop(): void {
    clearTimeout(this.#timer);
  }

  abort(reason: CliError): void {
    this.#controller.abort(reason);
  }
}

/**
 * Downloads the archive into `handle`, answering its length. A failure of the request or of a read is reported as the
 * abort's reason when there was one, since the fetch may report an abort in its own words.
 */
async function download(
  api: Api,
  id: string,
  version: number,
  handle: FileHandle,
  shown: string,
  idle: Idle,
): Promise<number> {
  const signal = idle.signal;
  const { body, length } = await api.exportArchive(id, version, idle).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error;
  });
  // The headers arrived: the limit runs again for the first chunk.
  idle.start();
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), idle.aborted]).catch(() => {
        throw signal.aborted
          ? signal.reason
          : new CliError(`the download broke off after ${received} of ${length} bytes`);
      });
      if (chunk.done) break;
      idle.start();
      received += chunk.value.byteLength;
      if (received > length) throw new CliError(`the API sent more than the ${length} bytes it announced`);
      // A write is not bounded: an interrupt or the idle limit takes effect once it returns. Closing the file waits
      // for a pending write anyway, so no cleanup could come sooner.
      await handle.writeFile(chunk.value).catch((error: unknown) => {
        throw cannotWrite(shown, error);
      });
    }
  } finally {
    // Ends the connection when the loop stopped early; after the last chunk it does nothing.
    void reader.cancel().catch(() => undefined);
  }
  if (received !== length) {
    throw new CliError(`the download ended after ${received} of the ${length} bytes the API announced`);
  }
  if (signal.aborted) throw signal.reason;
  return received;
}

/** Copies the part's bytes into `into`, the target's handle, at its current position. */
async function copyInto(part: string, into: FileHandle): Promise<void> {
  const from = await open(part, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await from.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) return;
      await into.writeFile(buffer.subarray(0, bytesRead));
    }
  } finally {
    await from.close();
  }
}

/**
 * Puts the part at the target without replacing anything there. A hard link fails when the target exists. Where the
 * file system makes none (FAT, exFAT, a network share), the target is created with `wx`, which fails the same way, and
 * only once that succeeds is it this command's: the part's bytes go into that handle, and a failure after it removes
 * the target. A failed create leaves the target alone, whatever the error.
 */
async function place(part: string, target: string, makeLink: ExportOptions["link"]): Promise<void> {
  const shown = JSON.stringify(target);
  const appeared = () =>
    new CliError(`${shown} appeared during the download; export left it as it is and wrote nothing there`);
  try {
    await makeLink(part, target);
    return;
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw appeared();
  }
  let copy: FileHandle;
  try {
    copy = await open(target, "wx");
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw appeared();
    throw cannotWrite(shown, error);
  }
  let failure: unknown;
  try {
    await copyInto(part, copy);
  } catch (error) {
    failure = error;
  }
  await copy.close().catch((error: unknown) => {
    failure ??= error;
  });
  if (failure === undefined) return;
  const error = cannotWrite(shown, failure);
  const note = await removeOwn(target, "the incomplete copy");
  throw note === undefined ? error : new LeftBehind(error, [note]);
}

/**
 * Exports `version` of `id`, or the latest version, which it reads first so that a publish meanwhile does not change
 * what it writes, to `file`, by default `<id>-v<n>.zip` in the current directory.
 */
export async function exportVersion(
  api: Api,
  id: string,
  version: number | undefined,
  file: string | undefined,
  options: ExportOptions,
): Promise<Exported> {
  const number = version ?? (await api.get(id)).version.number;
  const target = file ?? `${id}-v${number}.zip`;
  await refuseExisting(target);
  const part = `${target}.${randomBytes(6).toString("hex")}.part`;
  const shownPart = JSON.stringify(part);
  // `wx` creates the file or fails, so nothing existing is overwritten and no link is followed.
  const handle = await open(part, "wx").catch((error: unknown) => {
    throw cannotWrite(shownPart, error);
  });
  const idle = new Idle(options.idleMs);
  // From here an interrupt aborts the download instead of ending the process, so the part is removed. Once the
  // download is whole, the part is put in place and removed whatever comes.
  const unsubscribe = options.onInterrupt(() => idle.abort(new CliError("the export was interrupted")));
  try {
    let bytes: number;
    try {
      bytes = await download(api, id, number, handle, shownPart, idle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    } finally {
      idle.stop();
    }
    await handle.close().catch((error: unknown) => {
      throw cannotWrite(shownPart, error);
    });
    await place(part, target, options.link);
    const note = await removeOwn(part, PART);
    return {
      version: number,
      file: target,
      bytes,
      note: note === undefined ? undefined : `the archive is in place; ${note}`,
    };
  } catch (error) {
    const note = await removeOwn(part, PART);
    throw note === undefined ? error : leaving(error, note);
  } finally {
    unsubscribe();
  }
}
