import { describe, expect, it } from "vitest";

import { errorBody } from "./errors.ts";
import {
  descriptionSchema,
  limitSchema,
  patchSchema,
  restCreateMetaSchema,
  restUpdateMetaSchema,
  titleSchema,
  validate,
} from "./schemas.ts";

const files = [{ path: "index.html" }];
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: i === 0 ? "index.html" : `f${i}` }));

// PL-24, RES-1: each bound at and one past its limit, in its unit.
describe("bounds", () => {
  it("bounds a title at 1024 UTF-8 bytes", () => {
    expect(validate(titleSchema, "a".repeat(1024)).ok).toBe(true);
    expect(validate(titleSchema, "a".repeat(1025))).toEqual({
      ok: false,
      issues: [{ field: "body", reason: "too_long" }],
    });
    expect(validate(titleSchema, "é".repeat(512)).ok).toBe(true);
    expect(validate(titleSchema, `${"é".repeat(512)}a`).ok).toBe(false);
  });

  it("bounds a description at 16384 UTF-8 bytes", () => {
    expect(validate(descriptionSchema, "a".repeat(16384)).ok).toBe(true);
    expect(validate(descriptionSchema, "a".repeat(16385)).ok).toBe(false);
    expect(validate(descriptionSchema, "日".repeat(5461)).ok).toBe(true);
    expect(validate(descriptionSchema, `${"日".repeat(5461)}ab`).ok).toBe(false);
  });

  it("bounds the files of a request at 2000", () => {
    expect(validate(restCreateMetaSchema, { title: "t", files: many(2000) }).ok).toBe(true);
    expect(validate(restCreateMetaSchema, { title: "t", files: many(2001) })).toEqual({
      ok: false,
      issues: [{ field: "files", reason: "too_many" }],
    });
    expect(validate(restUpdateMetaSchema, { base_version: 1, remove: many(2001).map((f) => f.path) })).toEqual({
      ok: false,
      issues: [{ field: "remove", reason: "too_many" }],
    });
  });

  it("bounds a listing's page between 1 and 100", () => {
    expect(validate(limitSchema, 1).ok).toBe(true);
    expect(validate(limitSchema, 100).ok).toBe(true);
    expect(validate(limitSchema, 0).ok).toBe(false);
    expect(validate(limitSchema, 101).ok).toBe(false);
  });
});

describe("text", () => {
  it("keeps a title to one line of well-formed text", () => {
    for (const title of ["a\nb", "a\tb", "a\u0000b", "a b", "a\u0085b", "\ud800"]) {
      expect(validate(titleSchema, title)).toEqual({ ok: false, issues: [{ field: "body", reason: "invalid_text" }] });
    }
    expect(validate(titleSchema, "")).toEqual({ ok: false, issues: [{ field: "body", reason: "empty" }] });
  });

  it("takes any well-formed text as a description, tabs and line breaks included", () => {
    expect(validate(descriptionSchema, "line 1\n\tline 2\r\n").ok).toBe(true);
    expect(validate(descriptionSchema, "\udc00").ok).toBe(false);
  });
});

describe("issues", () => {
  it("names the field by its path and the reason from the closed set", () => {
    const result = validate(restCreateMetaSchema, {
      files: [{ path: "index.html" }, { path: "/abs" }, { path: "_v/x", content_type: "bad" }, { path: 3 }],
      extra: true,
    });
    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        { field: "title", reason: "required" },
        { field: "files[1].path", reason: "invalid_path" },
        { field: "files[2].path", reason: "reserved_path" },
        { field: "files[2].content_type", reason: "invalid_content_type" },
        { field: "files[3].path", reason: "invalid_type" },
        { field: "body", reason: "unknown_field" },
      ]),
    });
  });

  it("never echoes an unknown field's name or a value", () => {
    const result = validate(restCreateMetaSchema, { title: "t", files, "<marker>": "<value>" });
    expect(JSON.stringify(result)).not.toContain("marker");
    expect(JSON.stringify(result)).not.toContain("value>");
  });

  it("stores a path in NFC", () => {
    const result = validate(restCreateMetaSchema, { title: "t", files: [{ path: "é.html" }] });
    expect(result).toEqual({ ok: true, value: { title: "t", files: [{ path: "é.html" }] } });
  });

  it("takes the archive setting as archived, kept or null", () => {
    expect(validate(patchSchema, { archive: null }).ok).toBe(true);
    expect(validate(patchSchema, { archive: "kept", public: true }).ok).toBe(true);
    expect(validate(patchSchema, { archive: "auto" })).toEqual({
      ok: false,
      issues: [{ field: "archive", reason: "invalid_value" }],
    });
  });

  // Design.md section 4: the entry-file message, whatever else is wrong.
  it("leads with the entry-file message when index.html is missing", () => {
    const body = errorBody({
      code: "invalid_request",
      issues: [
        { field: "files", reason: "too_many" },
        { field: "files", reason: "missing_index" },
      ],
    });
    expect(body.error.message).toBe("every version needs index.html at its root");
  });
});
