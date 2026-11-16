import { describe, expect, it } from "vitest";

import { decodeBase64, decodeContent, encodeBase64, encodeContent, isTextual } from "./encoding.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);

// design.md section 6, "How bytes travel": base64 is RFC 4648 with padding and without whitespace.
describe("decodeBase64", () => {
  it.each<[string, Uint8Array]>([
    ["", bytes()],
    ["QQ==", bytes(0x41)],
    ["QUI=", bytes(0x41, 0x42)],
    ["QUJD", bytes(0x41, 0x42, 0x43)],
    ["+/8A", bytes(0xfb, 0xff, 0x00)],
  ])("decodes %j", (text, expected) => {
    expect(decodeBase64(text)).toEqual(expected);
  });

  it.each([
    ["missing padding", "QQ"],
    ["missing one pad", "QUI"],
    ["a space", "QU I="],
    ["a line break", "QUJD\nQUJD"],
    ["a trailing line break", "QUJD\n"],
    ["a tab", "\tQUJD"],
    ["padding inside", "QQ==QUJD"],
    ["three pads", "Q==="],
    ["base64url characters", "-_8A"],
    ["a non-alphabet character", "QUJ*"],
    ["non-ASCII", "QUJé"],
  ])("refuses %s", (_name, text) => {
    expect(decodeBase64(text)).toBeUndefined();
  });
});

describe("encodeBase64", () => {
  it("round-trips every byte value, across the chunk size", () => {
    const all = Uint8Array.from({ length: 0x8000 * 2 + 3 }, (_, i) => (i * 7) % 256);
    const text = encodeBase64(all);
    expect(text).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(decodeBase64(text)).toEqual(all);
  });
});

describe("decodeContent", () => {
  it("encodes utf8 content as UTF-8 and refuses text that is not well-formed", () => {
    expect(decodeContent("é😀", "utf8")).toEqual(new TextEncoder().encode("é😀"));
    expect(decodeContent("\ud800", "utf8")).toBeUndefined();
    expect(decodeContent("a\udc00b", "utf8")).toBeUndefined();
  });

  it("decodes base64 content in its exact form only", () => {
    expect(decodeContent("QQ==", "base64")).toEqual(bytes(0x41));
    expect(decodeContent("QQ", "base64")).toBeUndefined();
  });
});

describe("isTextual", () => {
  it.each([
    "text/html; charset=utf-8",
    "text/plain",
    "TEXT/CSS",
    "text/javascript; charset=utf-8",
    "application/json",
    "application/manifest+json",
    "application/xml",
    "image/svg+xml",
    "application/javascript",
  ])("counts %s as text", (type) => {
    expect(isTextual(type)).toBe(true);
  });

  it.each(["image/png", "application/octet-stream", "application/wasm", "font/woff2", "application/jsonx"])(
    "counts %s as binary",
    (type) => {
      expect(isTextual(type)).toBe(false);
    },
  );
});

// design.md section 8: read_file returns utf8 for textual, valid UTF-8 content and base64 otherwise.
describe("encodeContent", () => {
  it.each<[string, Uint8Array, string, "utf8" | "base64"]>([
    ["text", new TextEncoder().encode("<p>é</p>"), "text/html; charset=utf-8", "utf8"],
    ["text with a BOM", bytes(0xef, 0xbb, 0xbf, 0x41), "text/plain", "utf8"],
    ["text that is not UTF-8", bytes(0x63, 0x61, 0x66, 0xe9), "text/plain", "base64"],
    ["UTF-8 of a binary type", new TextEncoder().encode("abc"), "image/png", "base64"],
    ["empty text", bytes(), "text/plain", "utf8"],
  ])("sends %s so that it decodes to the same bytes", (_name, stored, type, encoding) => {
    const encoded = encodeContent(stored, type);
    expect(encoded.encoding).toBe(encoding);
    expect(decodeContent(encoded.content, encoded.encoding)).toEqual(stored);
  });
});
