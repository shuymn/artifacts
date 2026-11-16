/**
 * Content types (design.md section 6): the type given with a file, or one looked up from the extension with
 * `; charset=utf-8` on text types and `application/octet-stream` for an unknown extension. The table is `mime/lite`
 * (standard types only); the charset is own code.
 */
import mime from "mime/lite";

export const MAX_CONTENT_TYPE_BYTES = 255;
const FALLBACK = "application/octet-stream";

// RFC 9110 section 8.3.1: type "/" subtype *( OWS ";" OWS parameter ), ASCII only so it is a valid header value.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t \\x21-\\x7e])*"';
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*${TOKEN}=(?:${TOKEN}|${QUOTED}))*$`);

/** A content type a publish may give: `type/subtype` with parameters, at most 255 bytes. */
export function isContentType(value: string): boolean {
  return value.length <= MAX_CONTENT_TYPE_BYTES && MEDIA_TYPE.test(value);
}

/** The type of a stored path from its extension: the part of its last segment after the last `.`, if any. */
export function contentTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // A name without a dot, or whose only dot leads it (`.htaccess`), has no extension; mime would read it as one.
  if (dot <= 0 || dot === name.length - 1) return FALLBACK;
  const type = mime.getType(name.slice(dot + 1));
  if (type === null) return FALLBACK;
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}
