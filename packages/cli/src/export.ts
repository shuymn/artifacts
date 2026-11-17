/**
 * `export` (design.md section 9): writes a version's archive (section 8, "Export") to a file without overwriting
 * anything. The archive goes to `<file>.<random>.part` beside the target, created exclusively; only once the stream
 * has ended with the length `Content-Length` announced is the part linked to the target, which fails when the target
 * exists, and removed. Where the file system makes no hard links, an exclusive copy stands in for the link. On any
 * failure the command removes only what it created.
 */
import { randomBytes } from "node:crypto";
import { constants, copyFile, link, lstat, open, unlink, type FileHandle } from "node:fs/promises";

import type { Api } from "./api.ts";
import { CliError, codeOf } from "./errors.ts";

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
  /** How long the download may go without a byte. */
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

/** A promise that rejects with the signal's reason once it aborts, for racing a wait the signal may not end itself. */
function abortion(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // Nothing may await it: an abort after the download is not an unhandled rejection.
  aborted.catch(() => undefined);
  return aborted;
}

/**
 * Downloads the archive into `handle`, answering its length. `controller` aborts it: on `idleMs` without a byte, which
 * this arms, or on an interrupt. A failure of the request or of a read is reported as the abort's reason when there
 * was one, since the fetch may report an abort in its own words.
 */
async function download(
  api: Api,
  id: string,
  version: number,
  handle: FileHandle,
  shown: string,
  controller: AbortController,
  idleMs: number,
): Promise<number> {
  const signal = controller.signal;
  const aborted = abortion(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new CliError(`the download stalled: no bytes arrived for ${idleMs / 1000} s`));
    }, idleMs);
  };
  arm();
  try {
    const { body, length } = await Promise.race([api.exportArchive(id, version, signal), aborted]).catch(
      (error: unknown) => {
        throw signal.aborted ? signal.reason : error;
      },
    );
    arm();
    const reader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]).catch(() => {
          throw signal.aborted
            ? signal.reason
            : new CliError(`the download broke off after ${received} of ${length} bytes`);
        });
        if (chunk.done) break;
        arm();
        received += chunk.value.byteLength;
        if (received > length) throw new CliError(`the API sent more than the ${length} bytes it announced`);
        // writeFile on a handle writes the whole chunk at the current position.
        await handle.writeFile(chunk.value).catch((error: unknown) => {
          throw new CliError(`cannot write ${shown} (${codeOf(error) ?? "error"})`);
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Puts the part at the target without replacing anything there. A hard link fails when the target exists; where the
 * file system makes none (FAT, exFAT, a network share), `copyFile` with `COPYFILE_EXCL` stands in, which fails the same
 * way.
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
  try {
    await copyFile(part, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw appeared();
    // The copy creates the target exclusively, so a file there after any other failure is its own.
    await unlink(target).catch(() => undefined);
    throw new CliError(`cannot write ${shown} (${codeOf(error) ?? "error"})`);
  }
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
    throw new CliError(`cannot write ${shownPart} (${codeOf(error) ?? "error"})`);
  });
  const controller = new AbortController();
  // From here an interrupt aborts the download instead of ending the process, so the part is removed. Once the
  // download is whole, the part is put in place and removed whatever comes.
  const unsubscribe = options.onInterrupt(() => {
    controller.abort(new CliError("interrupted; the partial download was removed"));
  });
  let complete = false;
  try {
    let bytes: number;
    try {
      bytes = await download(api, id, number, handle, shownPart, controller, options.idleMs);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close().catch((error: unknown) => {
      throw new CliError(`cannot write ${shownPart} (${codeOf(error) ?? "error"})`);
    });
    await place(part, target, options.link);
    complete = true;
    return { version: number, file: target, bytes, note: await removePart(part, true) };
  } finally {
    if (!complete) await removePart(part, false);
    unsubscribe();
  }
}

/** Removes the part; after a success, a part that stays is reported rather than failing the export. */
async function removePart(part: string, placed: boolean): Promise<string | undefined> {
  try {
    await unlink(part);
    return undefined;
  } catch (error) {
    if (!placed || codeOf(error) === "ENOENT") return undefined;
    return `the archive is in place, but ${JSON.stringify(part)} could not be removed (${codeOf(error) ?? "error"})`;
  }
}
