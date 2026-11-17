/**
 * A ZIP reader for the export's tests (APPNOTE 6.3.10), independent of client-zip: it reads the central directory from
 * the end-of-central-directory records (ZIP64 ones included), then checks each entry's local header, bytes and data
 * descriptor against it, and the CRC-32 of the bytes. It reads what the export writes (STORE entries with a data
 * descriptor) and fails on anything else.
 */
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const DESCRIPTOR = 0x08074b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

export type ZipEntry = {
  readonly name: string;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  /** The MS-DOS time and date fields. */
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly size: bigint;
  readonly compressedSize: bigint;
  /** Where the entry's local header starts. */
  readonly offset: bigint;
  /** Whether its central record carries a ZIP64 extra field. */
  readonly zip64: boolean;
};

export type ZipDirectory = {
  readonly entries: readonly ZipEntry[];
  /** Whether the archive ends with the ZIP64 end records. */
  readonly zip64: boolean;
  /** Where the central directory starts, and its length. */
  readonly directoryOffset: bigint;
  readonly directorySize: bigint;
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(message: string): never {
  throw new Error(`zip: ${message}`);
}

class Cursor {
  private readonly view: DataView;
  constructor(
    private readonly bytes: Uint8Array,
    public at: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(): number {
    const value = this.view.getUint16(this.at, true);
    this.at += 2;
    return value;
  }
  u32(): number {
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }
  u64(): bigint {
    const value = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return value;
  }
  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.byteLength) fail("record runs past the end");
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }
}

/** The ZIP64 extra field's values for the fields whose central value is 0xFFFFFFFF, in APPNOTE's order. */
function zip64Extra(extra: Uint8Array, wanted: { size: boolean; compressed: boolean; offset: boolean }) {
  const cursor = new Cursor(extra, 0);
  while (cursor.at + 4 <= extra.byteLength) {
    const id = cursor.u16();
    const length = cursor.u16();
    const data = new Cursor(cursor.take(length), 0);
    if (id !== 0x0001) continue;
    return {
      size: wanted.size ? data.u64() : undefined,
      compressed: wanted.compressed ? data.u64() : undefined,
      offset: wanted.offset ? data.u64() : undefined,
    };
  }
  return undefined;
}

/** The end records and the central directory of `tail`, the archive's last bytes, which start at `tailOffset`. */
export function readDirectory(tail: Uint8Array, tailOffset: bigint): ZipDirectory {
  const endAt = tail.byteLength - 22;
  const end = new Cursor(tail, endAt);
  if (end.u32() !== END) fail("no end of central directory record (or a comment)");
  end.u16();
  end.u16();
  let count: bigint = BigInt(end.u16());
  if (BigInt(end.u16()) !== count) fail("entry counts differ");
  let directorySize = BigInt(end.u32());
  let directoryOffset = BigInt(end.u32());
  const zip64 = endAt >= 20 && new Cursor(tail, endAt - 20).u32() === LOCATOR64;
  if (zip64) {
    const locator = new Cursor(tail, endAt - 20);
    locator.u32();
    locator.u32();
    const end64Offset = locator.u64();
    const end64 = new Cursor(tail, Number(end64Offset - tailOffset));
    if (end64.u32() !== END64) fail("no ZIP64 end record where its locator points");
    end64.u64();
    end64.u16();
    end64.u16();
    end64.u32();
    end64.u32();
    count = end64.u64();
    if (end64.u64() !== count) fail("ZIP64 entry counts differ");
    directorySize = end64.u64();
    directoryOffset = end64.u64();
  } else if (count === BigInt(MAX16) || directorySize === BigInt(MAX32) || directoryOffset === BigInt(MAX32)) {
    fail("an end record field is saturated without ZIP64 records");
  }
  const central = new Cursor(tail, Number(directoryOffset - tailOffset));
  const entries: ZipEntry[] = [];
  for (let index = 0n; index < count; index++) {
    if (central.u32() !== CENTRAL) fail("no central directory record");
    const versionMadeBy = central.u16();
    const versionNeeded = central.u16();
    const flags = central.u16();
    const method = central.u16();
    const time = central.u16();
    const date = central.u16();
    const crc = central.u32();
    const compressed32 = central.u32();
    const size32 = central.u32();
    const nameLength = central.u16();
    const extraLength = central.u16();
    const commentLength = central.u16();
    central.u16();
    central.u16();
    central.u32();
    const offset32 = central.u32();
    const name = strictUtf8.decode(central.take(nameLength));
    const extra = central.take(extraLength);
    central.take(commentLength);
    const wanted = { size: size32 === MAX32, compressed: compressed32 === MAX32, offset: offset32 === MAX32 };
    const values = zip64Extra(extra, wanted);
    if ((wanted.size || wanted.compressed || wanted.offset) && values === undefined) fail("no ZIP64 extra field");
    entries.push({
      name,
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      time,
      date,
      crc,
      size: values?.size ?? BigInt(size32),
      compressedSize: values?.compressed ?? BigInt(compressed32),
      offset: values?.offset ?? BigInt(offset32),
      zip64: values !== undefined,
    });
  }
  if (BigInt(central.at) + tailOffset !== directoryOffset + directorySize) fail("central directory size differs");
  return { entries, zip64, directoryOffset, directorySize };
}

/** A local header at `at`: its name and where its bytes start. */
export function readLocalHeader(
  bytes: Uint8Array,
  at: number,
): { name: string; flags: number; method: number; dataAt: number } {
  const local = new Cursor(bytes, at);
  if (local.u32() !== LOCAL) fail("no local header where the directory points");
  local.u16();
  const flags = local.u16();
  const method = local.u16();
  local.u16();
  local.u16();
  local.u32();
  local.u32();
  local.u32();
  const nameLength = local.u16();
  const extraLength = local.u16();
  const name = strictUtf8.decode(local.take(nameLength));
  local.take(extraLength);
  return { name, flags, method, dataAt: local.at };
}

/** A data descriptor at `at`, with 8-byte sizes when `zip64`. */
export function readDescriptor(bytes: Uint8Array, at: number, zip64: boolean) {
  const descriptor = new Cursor(bytes, at);
  if (descriptor.u32() !== DESCRIPTOR) fail("no data descriptor after the bytes");
  const crc = descriptor.u32();
  const compressedSize = zip64 ? descriptor.u64() : BigInt(descriptor.u32());
  const size = zip64 ? descriptor.u64() : BigInt(descriptor.u32());
  return { crc, compressedSize, size, end: descriptor.at };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipFile = ZipEntry & { readonly bytes: Uint8Array };

/**
 * A whole archive read back: every entry of the central directory with its bytes, after checking that the local
 * headers, bytes and data descriptors follow one another exactly up to the central directory, and each CRC-32.
 */
export function readZip(archive: Uint8Array): { directory: ZipDirectory; files: ZipFile[] } {
  const directory = readDirectory(archive, 0n);
  const files: ZipFile[] = [];
  let at = 0;
  for (const entry of directory.entries) {
    if (BigInt(at) !== entry.offset) fail(`entry ${entry.name} does not start where the previous one ended`);
    const local = readLocalHeader(archive, at);
    if (local.name !== entry.name || local.flags !== entry.flags || local.method !== entry.method) {
      fail(`local header of ${entry.name} differs from its central record`);
    }
    if (entry.method !== 0 || entry.compressedSize !== entry.size) fail(`${entry.name} is not stored`);
    const bytes = archive.subarray(local.dataAt, local.dataAt + Number(entry.size));
    const descriptor = readDescriptor(archive, local.dataAt + Number(entry.size), entry.size >= BigInt(MAX32));
    if (descriptor.crc !== entry.crc || descriptor.size !== entry.size || descriptor.compressedSize !== entry.size) {
      fail(`data descriptor of ${entry.name} differs from its central record`);
    }
    if (crc32(bytes) !== entry.crc) fail(`CRC-32 of ${entry.name} differs`);
    files.push({ ...entry, bytes });
    at = descriptor.end;
  }
  if (BigInt(at) !== directory.directoryOffset) fail("bytes between the last entry and the central directory");
  return { directory, files };
}

/** MS-DOS time and date fields of a UTC time, as ZIP stores them (two-second resolution). */
export function dosTime(ms: number): { time: number; date: number } {
  const t = new Date(ms);
  return {
    time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | (t.getUTCSeconds() >> 1),
    date: ((t.getUTCFullYear() - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate(),
  };
}
