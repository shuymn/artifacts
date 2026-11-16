/**
 * Operation errors (design.md section 8, "Errors"): a closed set of codes from the shared operation layer, mapped once
 * to an HTTP status and to the JSON object both REST and MCP answer with (P5).
 */
export const OPERATION_ERRORS = [
  "invalid_request",
  "not_found",
  "version_conflict",
  "unavailable",
  "internal",
] as const;
export type OperationErrorCode = (typeof OPERATION_ERRORS)[number];

/** Why an input field was refused. `field` names it (`files[2].path`); the reason comes from this closed set. */
export const ISSUE_REASONS = [
  "required",
  "invalid_type",
  "unknown_field",
  "invalid_value",
  "out_of_range",
  "empty",
  "too_long",
  "too_many",
  "invalid_text",
  "invalid_path",
  "reserved_path",
  "duplicate_path",
  "missing_index",
  "not_in_base",
  "provided_and_removed",
  "invalid_content_type",
  "invalid_cursor",
  "invalid_json",
  "malformed_body",
  "unknown_part",
  "duplicate_part",
  "count_mismatch",
] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];
export type Issue = { readonly field: string; readonly reason: IssueReason };

const ISSUE_MESSAGES: Record<IssueReason, string> = {
  required: "a required field is missing",
  invalid_type: "a field has the wrong type",
  unknown_field: "the input has a field this operation does not take",
  invalid_value: "a field has a value this operation does not take",
  out_of_range: "a number is out of its range",
  empty: "a field is empty",
  too_long: "a text is longer than its bound",
  too_many: "a list is longer than its bound",
  invalid_text: "a text has a character it may not contain",
  invalid_path:
    'a path must be relative and /-separated, without a leading or trailing /, and without empty, "." or ".." segments',
  reserved_path: 'a path may not start with "_v/" or "cdn-cgi/"',
  duplicate_path: "a path is given twice",
  missing_index: "every version needs index.html at its root",
  not_in_base: "a removed path is not in the base version",
  provided_and_removed: "a path is both provided and removed",
  invalid_content_type: "a content type must be type/subtype with parameters, at most 255 bytes",
  invalid_cursor: "the cursor is not one this listing returned",
  invalid_json: "a JSON value could not be parsed",
  malformed_body: "the request body could not be parsed",
  unknown_part: 'a multipart part is named other than "meta" or "file"',
  duplicate_part: 'the "meta" part is given twice',
  count_mismatch: 'the number of "file" parts differs from meta.files',
};

export type OperationError =
  | { readonly code: "invalid_request"; readonly issues: readonly Issue[] }
  | { readonly code: "not_found" }
  | { readonly code: "version_conflict"; readonly latestVersion: number }
  | { readonly code: "unavailable" }
  | { readonly code: "internal" };

export type Failure = { readonly ok: false; readonly error: OperationError };
export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export const succeed = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: OperationError): Failure => ({ ok: false, error });
export const invalid = (issues: readonly Issue[]): Failure => fail({ code: "invalid_request", issues });

export const ERROR_STATUS: Record<OperationErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  version_conflict: 409,
  unavailable: 503,
  internal: 500,
};

const ERROR_MESSAGES: Record<Exclude<OperationErrorCode, "invalid_request">, string> = {
  not_found: "no live artifact, version or file matches",
  version_conflict: "base_version is not the latest version",
  unavailable: "the service is unavailable; try again",
  internal: "internal error",
};

export type ErrorBody = {
  readonly error: {
    readonly code: OperationErrorCode;
    readonly message: string;
    readonly issues?: readonly Issue[];
    readonly latest_version?: number;
  };
};

/** The JSON object REST answers with and MCP puts in a tool result with `isError: true`. */
export function errorBody(error: OperationError): ErrorBody {
  switch (error.code) {
    case "invalid_request": {
      // The entry-file message is the same sentence in every adapter (design.md section 4), whatever else is wrong.
      const lead = error.issues.find((issue) => issue.reason === "missing_index") ?? error.issues[0];
      const message = lead === undefined ? "the input is invalid" : ISSUE_MESSAGES[lead.reason];
      return { error: { code: error.code, message, issues: error.issues } };
    }
    case "version_conflict":
      return { error: { code: error.code, message: ERROR_MESSAGES[error.code], latest_version: error.latestVersion } };
    case "not_found":
    case "unavailable":
    case "internal":
      return { error: { code: error.code, message: ERROR_MESSAGES[error.code] } };
    default:
      return error satisfies never;
  }
}
