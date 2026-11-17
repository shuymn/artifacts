// PL-62, RES-2: the archive's entries (archive.ts) when the library cancels them through `throw`, which it calls when
// the response is cancelled: before the first entry was taken, and while a later body's open is pending. The export's
// own tests reach neither moment reliably, since the runtime delivers a cancellation at the archive's next write.
import { describe, expect, it, vi } from "vitest";

import { archiveEntries, type ArchiveFile } from "./archive.ts";

const DONE = { done: true, value: undefined };

/** A body that counts its cancellations. */
function counted(): { body: ReadableStream<Uint8Array>; cancels: () => number } {
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancels++;
    },
  });
  return { body, cancels: () => cancels };
}

async function* nothing(): AsyncGenerator<Uint8Array> {}

/** Entries over three files whose later bodies open only when the test resolves them. */
function deferredSource(first: ReadableStream<Uint8Array>) {
  const pending: PromiseWithResolvers<ReadableStream<Uint8Array>>[] = [];
  const open = vi.fn<(file: ArchiveFile) => Promise<ReadableStream<Uint8Array>>>(() => {
    const opened = Promise.withResolvers<ReadableStream<Uint8Array>>();
    pending.push(opened);
    return opened.promise;
  });
  const failed = vi.fn<(error: unknown) => void>();
  const files = [
    { path: "a", size: 1 },
    { path: "b", size: 1 },
    { path: "c", size: 1 },
  ];
  const entries = archiveEntries({ files, modified: new Date(0), first, open, read: nothing, failed });
  return { entries, open, failed, pending };
}

/** Lets the stream's cancellation and any settled promise run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PL-62: the archive's entries when the library cancels them", () => {
  it("cancels the first body when cancelled before the first entry, and opens nothing", async () => {
    const first = counted();
    const { entries, open, failed } = deferredSource(first.body);

    expect(await entries.throw(new Error("client gone"))).toEqual(DONE);
    await settle();
    expect(first.cancels()).toBe(1);
    expect(await entries.next()).toEqual(DONE);
    expect(open).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("cancels a body that finishes opening after the cancellation, returns no entry for it, and opens no other", async () => {
    const first = counted();
    const late = counted();
    const { entries, open, failed, pending } = deferredSource(first.body);

    expect(await entries.next()).toMatchObject({ done: false, value: { name: "a" } });
    const second = entries.next();
    expect(open).toHaveBeenCalledTimes(1);
    expect(await entries.throw(new Error("client gone"))).toEqual(DONE);
    pending[0]?.resolve(late.body);
    expect(await second).toEqual(DONE);
    await settle();
    expect(late.cancels()).toBe(1);
    expect(await entries.next()).toEqual(DONE);
    expect(open).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });
});
