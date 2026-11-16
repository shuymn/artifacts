/**
 * Input shapes (docs/decisions.md, "Input shapes"): one zod schema per input field, shared by REST validation and the
 * MCP tools (P5). `validate` turns zod's issues into `{ field, reason }` with reasons from errors.ts's closed set.
 * Checks across entries (duplicate paths, the merged entry file, removals against the base) run in the operations.
 */
import { z } from "zod";

import { isContentType } from "./content-type.ts";
import { ISSUE_MESSAGES, type Issue, type IssueReason } from "./errors.ts";
import { parseFilePath, utf8Length } from "./paths.ts";

/** Bounds of design.md section 6, each in its unit. */
export const LIMITS = {
  /** Title: one line, UTF-8 bytes. */
  titleBytes: 1024,
  /** Description: UTF-8 bytes; a listing carries it for up to 100 artifacts. */
  descriptionBytes: 16 * 1024,
  /** Files per version and per request: each new file costs up to four R2 calls of the 10,000 per invocation. */
  files: 2000,
  /** Page size of a listing. */
  pageMin: 1,
  pageMax: 100,
  pageDefault: 50,
} as const;

export const ARCHIVE_SETTINGS = ["archived", "kept"] as const;
export type ArchiveSetting = (typeof ARCHIVE_SETTINGS)[number];

export const ARCHIVED_FILTERS = ["exclude", "only", "include"] as const;
export type ArchivedFilter = (typeof ARCHIVED_FILTERS)[number];

const reasonIssue = (reason: IssueReason) => ({
  code: "custom" as const,
  message: ISSUE_MESSAGES[reason],
  params: { reason },
});

/** Unicode control characters and line or paragraph separators: a title is one line. */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export const titleSchema = z.string().superRefine((value, ctx) => {
  if (!value.isWellFormed()) ctx.addIssue(reasonIssue("invalid_text"));
  else if (value === "") ctx.addIssue(reasonIssue("empty"));
  else if (LINE_BREAKING.test(value)) ctx.addIssue(reasonIssue("invalid_text"));
  else if (utf8Length(value) > LIMITS.titleBytes) ctx.addIssue(reasonIssue("too_long"));
});

export const descriptionSchema = z.string().superRefine((value, ctx) => {
  if (!value.isWellFormed()) ctx.addIssue(reasonIssue("invalid_text"));
  else if (utf8Length(value) > LIMITS.descriptionBytes) ctx.addIssue(reasonIssue("too_long"));
});

/** A publish path; the output is its stored form (NFC). */
export const filePathSchema = z.string().transform((value, ctx) => {
  const parsed = parseFilePath(value);
  if (parsed.ok) return parsed.path;
  ctx.addIssue(reasonIssue(parsed.reason));
  return z.NEVER;
});

export const contentTypeSchema = z.string().superRefine((value, ctx) => {
  if (!isContentType(value)) ctx.addIssue(reasonIssue("invalid_content_type"));
});

export const versionNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const archiveSettingSchema = z.enum(ARCHIVE_SETTINGS).nullable();
export const archivedFilterSchema = z.enum(ARCHIVED_FILTERS);
export const limitSchema = z.number().int().min(LIMITS.pageMin).max(LIMITS.pageMax);
export const removeSchema = z.array(filePathSchema).max(LIMITS.files);

/** REST: one entry of `meta.files`, describing the part named `file` at the same position. */
export const restFileSchema = z.strictObject({ path: filePathSchema, content_type: contentTypeSchema.optional() });

/** REST: the `meta` part of a create. */
export const restCreateMetaSchema = z.strictObject({
  title: titleSchema,
  description: descriptionSchema.optional(),
  files: z.array(restFileSchema).max(LIMITS.files),
});

/** REST: the `meta` part of an update. */
export const restUpdateMetaSchema = z.strictObject({
  base_version: versionNumberSchema,
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  files: z.array(restFileSchema).max(LIMITS.files).optional(),
  remove: removeSchema.optional(),
});

/** REST: the body of `PATCH /v1/artifacts/{id}`. */
export const patchSchema = z.strictObject({
  public: z.boolean().optional(),
  archive: archiveSettingSchema.optional(),
});

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** At most this many issues are returned; the first ones suffice to fix an input. */
const MAX_ISSUES = 50;

function fieldOf(path: readonly PropertyKey[]): string {
  let field = "";
  for (const key of path)
    field += typeof key === "number" ? `[${key}]` : field === "" ? String(key) : `.${String(key)}`;
  return field;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

/** The reasons a field check of this module reports through a custom issue. */
const CHECK_REASONS = [
  "invalid_text",
  "too_long",
  "empty",
  "invalid_path",
  "reserved_path",
  "invalid_content_type",
] as const satisfies readonly IssueReason[];

function reasonOf(issue: z.core.$ZodIssue, input: unknown): IssueReason {
  switch (issue.code) {
    case "invalid_type":
      return valueAt(input, issue.path) === undefined ? "required" : "invalid_type";
    case "unrecognized_keys":
      return "unknown_field";
    case "too_big":
      return issue.origin === "string" ? "too_long" : issue.origin === "array" ? "too_many" : "out_of_range";
    case "too_small":
      return issue.origin === "string" ? "empty" : "out_of_range";
    case "custom": {
      const reason: unknown = issue.params?.reason;
      return CHECK_REASONS.find((known) => known === reason) ?? "invalid_value";
    }
    default:
      return "invalid_value";
  }
}

/**
 * `input` checked against `schema`. Issues name the field by its path (`files[2].path`) and never echo a value or an
 * unknown key's name.
 */
export function validate<T>(schema: z.ZodType<T>, input: unknown, prefix: readonly PropertyKey[] = []): Validated<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    field: fieldOf([...prefix, ...issue.path]) || "body",
    reason: reasonOf(issue, input),
  }));
  return { ok: false, issues };
}
