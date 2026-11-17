/**
 * ZIP64 at its boundaries (PL-60): versions whose files are 4 GiB long, written into D1 directly, and a bucket that
 * generates their bytes, so nothing of that size is stored or held. The archive is read as it streams: each local
 * header, the bytes skipped by count, each data descriptor, then the central directory at the end.
 */
import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { archiveLength } from "./archive.ts";
import { createStatements, type FileRow } from "./db.ts";
import { newArtifactId } from "./id.ts";
import { BucketProbe, World } from "./test-support.ts";
import { readDescriptor, readDirectory, readLocalHeader, type ZipEntry } from "./zip-test-support.ts";

const MAX32 = 0xffffffff;
const CHUNK = 4 * 1024 * 1024;

/** `size` zero bytes, `CHUNK` at a time, made as they are read. */
function zeros(size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (left === 0) {
          controller.close();
          return;
        }
        const length = Math.min(left, CHUNK);
        left -= length;
        controller.enqueue(new Uint8Array(length));
      },
    },
    { highWaterMark: 0 },
  );
}

/** A response body read on demand: bytes taken whole, or skipped by count. */
class StreamCursor {
  offset = 0;
  private chunk: Uint8Array = new Uint8Array();
  private at = 0;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    while (this.at >= this.chunk.byteLength) {
      const { done, value } = await this.reader.read();
      if (done) return false;
      this.chunk = value;
      this.at = 0;
    }
    return true;
  }

  async take(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (!(await this.fill())) throw new Error("the archive ended early");
      const count = Math.min(length - filled, this.chunk.byteLength - this.at);
      out.set(this.chunk.subarray(this.at, this.at + count), filled);
      filled += count;
      this.at += count;
    }
    this.offset += length;
    return out;
  }

  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      if (!(await this.fill())) throw new Error("the archive ended early");
      const count = Math.min(left, this.chunk.byteLength - this.at);
      this.at += count;
      left -= count;
    }
    this.offset += length;
  }

  /** Everything left, to the end of the stream. */
  async rest(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [this.chunk.subarray(this.at)];
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) break;
      parts.push(value);
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    this.offset += out.byteLength;
    return out;
  }
}

export type Generated = { readonly path: string; readonly size: number };

/**
 * Exports a version holding `files` (in path order) through REST and reads it back: each entry's sizes, offset and
 * ZIP64 records, and the length `predictLength` gave, which the response announced and delivered.
 */
export async function exportGenerated(files: readonly Generated[]): Promise<{
  entries: readonly ZipEntry[];
  /** Where each local header started, as counted while reading. */
  offsets: readonly number[];
  zip64: boolean;
}> {
  const world = new World();
  const id = newArtifactId();
  const rows: FileRow[] = files.map((file, index) => ({
    path: file.path,
    sha256: index.toString(16).padStart(64, "0"),
    size: file.size,
    content_type: "application/octet-stream",
  }));
  await env.DB.batch(
    createStatements(env.DB, {
      id,
      number: 1,
      createdAt: world.clock.now,
      publishedBy: "codex",
      title: "zip64",
      description: "",
      files: rows,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    }),
  );
  const bucket = new BucketProbe();
  world.env = { ...world.env, FILES: bucket.binding };
  const sizes = new Map(rows.map((row) => [`a/${id}/${row.sha256}`, row.size]));
  bucket.behave = (op, key) => {
    const size = sizes.get(key);
    return op === "get" && size !== undefined ? Promise.resolve({ body: zeros(size) }) : undefined;
  };

  const response = await world.api("GET", `/v1/artifacts/${id}/versions/1/export`);
  expect(response.status).toBe(200);
  const predicted = archiveLength(rows);
  expect(response.headers.get("Content-Length")).toBe(String(predicted));
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const cursor = new StreamCursor(reader);
  const offsets: number[] = [];
  for (const file of files) {
    offsets.push(cursor.offset);
    const fixed = await cursor.take(30);
    const view = new DataView(fixed.buffer);
    const variable = await cursor.take(view.getUint16(26, true) + view.getUint16(28, true));
    const header = new Uint8Array(30 + variable.byteLength);
    header.set(fixed);
    header.set(variable, 30);
    const local = readLocalHeader(header, 0);
    expect({ name: local.name, method: local.method, flags: local.flags }).toEqual({
      name: file.path,
      method: 0,
      flags: 0x0808,
    });
    await cursor.skip(file.size);
    const zip64 = file.size >= MAX32;
    const descriptor = readDescriptor(await cursor.take(zip64 ? 24 : 16), 0, zip64);
    expect({ size: descriptor.size, compressedSize: descriptor.compressedSize }).toEqual({
      size: BigInt(file.size),
      compressedSize: BigInt(file.size),
    });
  }
  const tailOffset = cursor.offset;
  const tail = await cursor.rest();
  expect(BigInt(cursor.offset)).toBe(predicted);
  const directory = readDirectory(tail, BigInt(tailOffset));
  expect(directory.directoryOffset).toBe(BigInt(tailOffset));
  expect(directory.entries.map((entry) => [entry.name, entry.size, entry.compressedSize, entry.offset])).toEqual(
    files.map((file, index) => [file.path, BigInt(file.size), BigInt(file.size), BigInt(offsets[index] ?? -1)]),
  );
  return { entries: directory.entries, offsets, zip64: directory.zip64 };
}

export { MAX32 };
