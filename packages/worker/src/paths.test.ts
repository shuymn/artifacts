import { describe, expect, it } from "vitest";

import { contentTypeFor, isContentType } from "./content-type.ts";
import { decodeSegment, parseFilePath, resolveFileParam, resolveRequestPath } from "./paths.ts";

// PL-15, SRV-2: one strict percent-decoding per segment.
describe("decodeSegment", () => {
  it.each([
    ["plain", "plain"],
    ["%25", "%"],
    ["%23", "#"],
    ["%3F", "?"],
    ["%3f", "?"],
    ["%5C", "\\"],
    ["a%20b", "a b"],
    ["%E6%97%A5", "日"],
    // NFD (e + combining acute) to NFC.
    ["e%CC%81", "é"],
    // A leading BOM is part of the name, not stripped.
    ["%EF%BB%BFx", "﻿x"],
    // Decoded once: %2541 is "%41", not "A".
    ["%2541", "%41"],
  ])("decodes %j to %j", (raw, decoded) => {
    expect(decodeSegment(raw)).toBe(decoded);
  });

  it.each([
    ["%", "a lone percent sign"],
    ["%2", "a truncated escape"],
    ["%zz", "non-hex digits"],
    ["%2F", "an encoded slash"],
    ["%2f", "an encoded slash in lowercase"],
    ["%00", "an encoded NUL"],
    ["%FF", "a byte that is never UTF-8"],
    ["%C3", "a truncated sequence"],
    ["%C0%AF", "an overlong encoding"],
    ["%ED%A0%80", "an encoded surrogate"],
    ["é", "a raw non-ASCII character"],
  ])("refuses %j (%s)", (raw) => {
    expect(decodeSegment(raw)).toBeUndefined();
  });
});

// Design.md section 6, "Paths"; PL-32.
describe("parseFilePath", () => {
  it.each([
    ["index.html", "index.html"],
    ["css/site.css", "css/site.css"],
    ["a%b#c?d\\e", "a%b#c?d\\e"],
    ["Case/File.HTML", "Case/File.HTML"],
    ["é.txt", "é.txt"],
    ["v/_v/x", "v/_v/x"],
    ["x/cdn-cgi/y", "x/cdn-cgi/y"],
    ["_vx/y", "_vx/y"],
  ])("accepts %j as %j", (raw, stored) => {
    expect(parseFilePath(raw)).toEqual({ ok: true, path: stored });
  });

  it.each([
    ["", "invalid_path"],
    ["/index.html", "invalid_path"],
    ["dir/", "invalid_path"],
    ["a//b", "invalid_path"],
    ["./a", "invalid_path"],
    ["a/../b", "invalid_path"],
    ["..", "invalid_path"],
    ["_v/1/index.html", "reserved_path"],
    ["_v", "reserved_path"],
    ["cdn-cgi/trace", "reserved_path"],
    ["a\0b", "invalid_text"],
    ["\ud800.txt", "invalid_text"],
  ])("refuses %j with %s", (raw, reason) => {
    expect(parseFilePath(raw)).toEqual({ ok: false, reason });
  });

  // RES-1: 1 KiB of UTF-8, measured after NFC.
  it("bounds a path at 1024 UTF-8 bytes", () => {
    expect(parseFilePath("a".repeat(1024)).ok).toBe(true);
    expect(parseFilePath("a".repeat(1025))).toEqual({ ok: false, reason: "too_long" });
    // 341 three-byte characters are 1023 bytes; one more is 1026.
    expect(parseFilePath(`${"日".repeat(341)}a`).ok).toBe(true);
    expect(parseFilePath("日".repeat(342))).toEqual({ ok: false, reason: "too_long" });
    // 512 NFD pairs (e + U+0301, 3 bytes) become 512 two-byte characters in NFC: 1024 bytes.
    expect(parseFilePath("é".repeat(512)).ok).toBe(true);
  });
});

// PL-16, SRV-2: the version and path a pathname selects; never a fallback from a pinned path to the latest.
describe("resolveRequestPath", () => {
  it.each([
    ["/", { version: null, file: "index.html", directory: null }],
    ["/style.css", { version: null, file: "style.css", directory: "style.css/index.html" }],
    ["/docs/", { version: null, file: "docs/index.html", directory: null }],
    ["/_v/2/", { version: 2, file: "index.html", directory: null }],
    ["/_v/2", { version: 2, file: null, directory: "index.html" }],
    ["/_v/12/img/a.png", { version: 12, file: "img/a.png", directory: "img/a.png/index.html" }],
    ["/a%25b%23c%3Fd", { version: null, file: "a%b#c?d", directory: "a%b#c?d/index.html" }],
    ["/%5Fv/1/x", { version: null, file: "_v/1/x", directory: "_v/1/x/index.html" }],
  ])("resolves %j", (pathname, resolved) => {
    expect(resolveRequestPath(pathname)).toEqual(resolved);
  });

  it.each([
    "/_v",
    "/_v/",
    "/_v/0/",
    "/_v/01/",
    "/_v/-1/",
    "/_v/1.0/",
    "/_v/x/",
    "/_v/index.html",
    "/_v/99999999999999999/",
    "/a//b",
    "//",
    "/a/%2F/b",
    "/%2e%2e/x",
    "/%zz",
  ])("answers 404 for %j", (pathname) => {
    expect(resolveRequestPath(pathname)).toBeUndefined();
  });

  it("resolves a REST file path within its version", () => {
    expect(resolveFileParam(3, "css/a%20b.css")).toEqual({
      version: 3,
      file: "css/a b.css",
      directory: "css/a b.css/index.html",
    });
    expect(resolveFileParam(3, "docs/")).toEqual({ version: 3, file: "docs/index.html", directory: null });
    expect(resolveFileParam(3, "a%2Fb")).toBeUndefined();
  });
});

// Design.md section 6, "Content types".
describe("content types", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["css/site.CSS", "text/css; charset=utf-8"],
    ["app.js", "text/javascript; charset=utf-8"],
    ["data.json", "application/json"],
    ["logo.png", "image/png"],
    ["icon.svg", "image/svg+xml"],
    ["archive.tar.gz", "application/gzip"],
    ["README", "application/octet-stream"],
    ["html", "application/octet-stream"],
    [".htaccess", "application/octet-stream"],
    ["file.", "application/octet-stream"],
    ["file.unknownext", "application/octet-stream"],
    ["dir.html/name", "application/octet-stream"],
  ])("types %j as %j", (path, type) => {
    expect(contentTypeFor(path)).toBe(type);
  });

  it("accepts a given type with parameters, up to 255 bytes", () => {
    expect(isContentType("text/plain")).toBe(true);
    expect(isContentType('text/plain; charset="utf-8"; format=flowed')).toBe(true);
    expect(isContentType(`application/x-${"a".repeat(241)}`)).toBe(true);
    expect(isContentType(`application/x-${"a".repeat(242)}`)).toBe(false);
  });

  it.each(["text", "text/", "/plain", "text/plain;", "text/plain\r\nX: y", "text/plain; a=b c", "téxt/plain"])(
    "refuses the given type %j",
    (type) => {
      expect(isContentType(type)).toBe(false);
    },
  );
});
