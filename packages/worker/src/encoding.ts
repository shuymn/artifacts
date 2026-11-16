/**
 * How file bytes travel through MCP (design.md section 6, "How bytes travel"): `utf8`, well-formed Unicode sent as
 * UTF-8, or `base64`, RFC 4648 with padding and without whitespace. `atob` decodes after an exact-form check, because
 * it skips whitespace (docs/decisions.md, "base64").
 */
export const ENCODINGS = ["utf8", "base64"] as const;
export type Encoding = (typeof ENCODINGS)[number];

/** The ASCII whitespace `atob` would skip. */
const WHITESPACE = /[\t\n\f\r ]/;

/** The bytes of a base64 text in its exact form, or undefined for any other text. */
export function decodeBase64(text: string): Uint8Array | undefined {
  // A length that is a multiple of 4 leaves `atob` no padding to infer; it refuses `=` anywhere but the end.
  if (text.length % 4 !== 0 || WHITESPACE.test(text)) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Below the engine's limit on call arguments. */
const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** A publish file's content as bytes, or undefined when it does not have the form of its encoding. */
export function decodeContent(content: string, encoding: Encoding): Uint8Array | undefined {
  if (encoding === "base64") return decodeBase64(content);
  return content.isWellFormed() ? new TextEncoder().encode(content) : undefined;
}

// A BOM stays in the text, so the text encodes back to the same bytes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Whether a content type names text: `text/*`, JSON, XML and JavaScript types, by their essence. */
export function isTextual(contentType: string): boolean {
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const [type, subtype = ""] = essence.split("/");
  return (
    type === "text" ||
    subtype === "json" ||
    subtype.endsWith("+json") ||
    subtype === "xml" ||
    subtype.endsWith("+xml") ||
    essence === "application/javascript" ||
    essence === "application/ecmascript"
  );
}

/**
 * `read_file`'s content (design.md section 8): `utf8` for textual, valid UTF-8 content, `base64` otherwise. Either way
 * the content decodes back to exactly the stored bytes.
 */
export function encodeContent(bytes: Uint8Array, contentType: string): { encoding: Encoding; content: string } {
  if (isTextual(contentType)) {
    try {
      return { encoding: "utf8", content: strictUtf8.decode(bytes) };
    } catch {
      // Not valid UTF-8: sent as base64 below.
    }
  }
  return { encoding: "base64", content: encodeBase64(bytes) };
}
