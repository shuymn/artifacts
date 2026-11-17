/**
 * A version's files as a ZIP archive (design.md section 8, "Export"). client-zip writes the format: STORE entries with
 * UTF-8 names (the language encoding flag), ZIP64 records where a size or offset needs them, and the exact length from
 * the listed names and sizes. This module decides which paths can be extracted as stored, feeds the library one body at
 * a time, and pipes its stream through a `FixedLengthStream` of that length, since Workers send `Content-Length` only
 * for a body of known length.
 */
import { makeZip, predictLength } from "client-zip";

export type ArchiveFile = { readonly path: string; readonly size: number };

/**
 * The paths, in their given order, that cannot be extracted as stored: one containing `\`, which ZIP names never use
 * (APPNOTE 4.4.17.1) and extractors read differently, and one that another path uses as a directory (`a` beside `a/b`).
 */
export function unextractablePaths(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      directories.add(path.slice(0, slash));
    }
  }
  return paths.filter((path) => path.includes("\\") || directories.has(path));
}

/** The archive's length in bytes, computed by the library from the names and sizes it will write. */
export function archiveLength(files: readonly ArchiveFile[]): bigint {
  return predictLength(files.map((file) => ({ name: file.path, size: file.size })));
}

export type ArchiveSource<F extends ArchiveFile> = {
  /** The files in the order the archive holds them. */
  readonly files: readonly F[];
  /** Every entry's time: the version's, so a version's archive has the same bytes on every export. */
  readonly modified: Date;
  /** The first file's body, opened before the response so that a failure there is an operation error. */
  readonly first: ReadableStream<Uint8Array>;
  /** Opens a later file's body; its wait is bounded by the caller. */
  readonly open: (file: F) => Promise<ReadableStream<Uint8Array>>;
  /** A body's bytes through `reader`, exactly `size` of them, each wait bounded; cancels `reader` on every exit. */
  readonly read: (reader: ReadableStreamDefaultReader<Uint8Array>, size: number) => AsyncIterable<Uint8Array>;
  /** Called once with the first failure after the response began; a cancellation is not a failure. */
  readonly failed: (error: unknown) => void;
};

/** One file as the library takes it: its name, size and time, and its body's bytes. */
export type ArchiveEntry = {
  readonly name: string;
  readonly size: number;
  readonly lastModified: Date;
  readonly input: AsyncIterable<Uint8Array>;
};

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/** The library's input, with the `throw` the library calls when its stream is cancelled. */
export type ArchiveEntries = AsyncIterableIterator<ArchiveEntry, undefined> & {
  throw(reason?: unknown): Promise<IteratorResult<ArchiveEntry, undefined>>;
};

/**
 * The library's input: one entry per file, each with its body. The library asks for the next entry only after it has
 * read the previous body to its end, and this iterator closes the previous body before it opens the next, so one body
 * is open at a time. When the library's stream is cancelled (the client went away), the library calls `throw`
 * (client-zip 2.4.3): the open body is cancelled and no later one is opened, also when the call comes while an open is
 * pending or before the first entry was taken.
 */
export function archiveEntries<F extends ArchiveFile>(source: ArchiveSource<F>): ArchiveEntries {
  let index = 0;
  // The reader of the body opened last; cancelling it again once it is done or cancelled does nothing.
  let body = source.first.getReader();
  let ended = false;
  const close = () => {
    body.cancel().catch(() => {});
  };
  const fail = (error: unknown) => {
    if (ended) return;
    ended = true;
    close();
    source.failed(error);
  };
  async function* bytes(reader: ReadableStreamDefaultReader<Uint8Array>, size: number) {
    try {
      yield* source.read(reader, size);
    } catch (error) {
      // After a cancellation the reader ends short; that is not a failure.
      fail(error);
      throw error;
    }
  }
  const iterator: ArchiveEntries = {
    async next() {
      const file = source.files[index];
      if (ended || file === undefined) {
        ended = true;
        close();
        return DONE;
      }
      if (index > 0) {
        close();
        let opened: ReadableStream<Uint8Array>;
        try {
          opened = await source.open(file);
        } catch (error) {
          fail(error);
          throw error;
        }
        if (ended) {
          // Cancelled while the open was pending: the body arrived for nobody.
          opened.cancel().catch(() => {});
          return DONE;
        }
        body = opened.getReader();
      }
      index++;
      return {
        done: false,
        value: { name: file.path, size: file.size, lastModified: source.modified, input: bytes(body, file.size) },
      };
    },
    async throw() {
      ended = true;
      close();
      return DONE;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/**
 * The archive's bytes: the library's stream piped through a `FixedLengthStream` of `length`, whose readable side the
 * response carries. The pipe carries an error forward, so a failure aborts the response, and a cancellation back, so
 * the client going away cancels the library's stream and with it the entries; the stream also refuses more or fewer
 * bytes than `length`. Failures are reported through `source.failed` where they arise, so the pipe's own rejection is
 * not reported again.
 */
export function archiveStream<F extends ArchiveFile>(
  source: ArchiveSource<F>,
  length: bigint,
): ReadableStream<Uint8Array> {
  const fixed = new FixedLengthStream(length);
  makeZip(archiveEntries(source))
    .pipeTo(fixed.writable)
    .catch(() => {});
  return fixed.readable;
}

/** What an export's answer carries: the version it names, the archive's length, and its bytes unless a `HEAD` asked. */
export type Archive = {
  readonly id: string;
  readonly number: number;
  readonly length: bigint;
  readonly body: ReadableStream<Uint8Array> | null;
};

/**
 * The export's answer (design.md section 8, "Export"): `application/zip` as an attachment named `<id>-v<n>.zip`,
 * `no-store`, `nosniff` and the archive's length, over `hostHeaders`, the host class's.
 */
export function archiveResponse(archive: Archive, hostHeaders: Record<string, string>): Response {
  return new Response(archive.body, {
    headers: {
      ...hostHeaders,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archive.id}-v${archive.number}.zip"`,
      "Content-Length": String(archive.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
