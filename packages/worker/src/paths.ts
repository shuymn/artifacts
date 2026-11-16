/**
 * File paths (design.md section 6). `parseFilePath` checks a path given to a publish; `resolveRequestPath` turns the
 * pathname a request arrives with into the version and path it selects (SRV-2). Own code: the exact rule is the point.
 */

/** Paths, titles: at most 1 KiB of UTF-8. */
export const MAX_PATH_BYTES = 1024;
export const ENTRY_FILE = "index.html";

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

export const PATH_PROBLEMS = ["invalid_text", "too_long", "invalid_path", "reserved_path"] as const;
export type PathProblem = (typeof PATH_PROBLEMS)[number];

export type PathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: PathProblem };

/**
 * A publish path in its stored form (NFC): relative, `/`-separated, no leading or trailing `/`, no empty, `.` or `..`
 * segment, a first segment other than `_v` and `cdn-cgi`, any Unicode scalar value except NUL, at most 1 KiB of UTF-8.
 */
export function parseFilePath(raw: string): PathResult {
  if (!raw.isWellFormed() || raw.includes("\0")) return { ok: false, reason: "invalid_text" };
  const path = raw.normalize("NFC");
  if (utf8Length(path) > MAX_PATH_BYTES) return { ok: false, reason: "too_long" };
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, reason: "invalid_path" };
  }
  if (segments[0] === "_v" || segments[0] === "cdn-cgi") return { ok: false, reason: "reserved_path" };
  return { ok: true, path };
}

/**
 * One strict percent-decoding of a raw path segment (PL-15): every `%` starts an escape of two hex digits, the bytes
 * are UTF-8 without a replacement, and the result is NFC. An encoded `/` or a NUL yields undefined, as does any
 * malformed escape.
 */
export function decodeSegment(raw: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x25) {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (code < 0x80) {
      bytes.push(code);
    } else {
      // URL parsing percent-encodes non-ASCII in a pathname, so a raw one never arrives from a request.
      return undefined;
    }
  }
  let text: string;
  try {
    text = strictUtf8.decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
  if (text.includes("/") || text.includes("\0")) return undefined;
  return text.normalize("NFC");
}

/**
 * What a request pathname selects: the version (null for the latest) and the file path to serve. `directory` is set
 * when the path names no file of its own but may name a directory, whose `index.html` is then reached by a 308 to the
 * path with `/`; `/_v/<n>` is such a directory. Undefined means 404 whatever the version holds.
 */
export type ResolvedPath = {
  readonly version: number | null;
  /** The stored path the request names, or null when it can only be a directory (`/_v/<n>`). */
  readonly file: string | null;
  /** The `index.html` that a 308 to the path with `/` would serve, or null when the path ends with `/`. */
  readonly directory: string | null;
};

/** `<n>` of `/_v/<n>/`: a canonical decimal (no sign, no leading zero) of a safe integer of at least 1. */
export function parseVersionNumber(raw: string): number | undefined {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * SRV-2: resolves the pathname the Worker receives, after URL parsing removed dot segments: `/_v/<n>/` selects version
 * `n`, anything else the latest; each remaining segment is decoded once; a trailing `/` adds `index.html`. Only the
 * selected version is ever looked up: a pinned path never falls back to the latest.
 */
export function resolveRequestPath(pathname: string): ResolvedPath | undefined {
  if (!pathname.startsWith("/")) return undefined;
  let segments = pathname.slice(1).split("/");
  let version: number | null = null;
  if (segments[0] === "_v") {
    const n = segments[1] === undefined ? undefined : parseVersionNumber(segments[1]);
    if (n === undefined) return undefined;
    version = n;
    segments = segments.slice(2);
    if (segments.length === 0) return { version, file: null, directory: ENTRY_FILE };
  }
  return resolveSegments(version, segments);
}

/** A REST `{path}` (the raw rest of the URL after `/files/`), resolved like a request path within one version. */
export function resolveFileParam(version: number, raw: string): ResolvedPath | undefined {
  return resolveSegments(version, raw.split("/"));
}

function resolveSegments(version: number | null, segments: readonly string[]): ResolvedPath | undefined {
  const trailingSlash = segments.at(-1) === "";
  const named = trailingSlash ? segments.slice(0, -1) : segments;
  const decoded: string[] = [];
  for (const raw of named) {
    const segment = decodeSegment(raw);
    if (segment === undefined || segment === "" || segment === "." || segment === "..") return undefined;
    decoded.push(segment);
  }
  const path = decoded.join("/");
  if (trailingSlash) {
    const file = path === "" ? ENTRY_FILE : `${path}/${ENTRY_FILE}`;
    return utf8Length(file) > MAX_PATH_BYTES ? undefined : { version, file, directory: null };
  }
  if (path === "" || utf8Length(path) > MAX_PATH_BYTES) return undefined;
  const directory = `${path}/${ENTRY_FILE}`;
  return { version, file: path, directory: utf8Length(directory) > MAX_PATH_BYTES ? null : directory };
}
