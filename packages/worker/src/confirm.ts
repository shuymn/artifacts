/**
 * The confirmation pages (design.md section 10): `/a/<id>/public` and `/a/<id>/delete` on the app host, a browser's
 * only way to change an artifact (P3, ISO-3). index.ts has answered any method but GET, HEAD and POST with 405 and
 * checked Access with the app audience (ACC-1) before this runs, so no body is read and no storage touched before
 * either. index.ts also applies these pages' headers (`withConfirmHeaders`) and the gallery's CSP with what each page
 * adds to every answer, refusals and failures included (ISO-5).
 *
 * A `POST` changes the artifact only with `Origin` equal to the app origin and `Sec-Fetch-Site: same-origin`, so no
 * page of another origin, an artifact's included, can submit the form; then a counted form that names the desired
 * state (RES-1). It calls the operation REST calls, logged `via: "gallery"`; a refusal logs `confirm.refused` with its
 * reason only (DATA-1). No cookie is read or set (ISO-4).
 */
import { readBytes } from "./body.ts";
import { scriptSource } from "./encoding.ts";
import type { OperationErrorCode } from "./errors.ts";
import type { Markup } from "./gallery/html.ts";
import { CONFIRM_SCRIPT_TEXT, deletePage, RESULT_SCRIPT_TEXT, resultPage, visibilityPage } from "./gallery/pages.ts";
import type { PagePolicy } from "./gallery/route.ts";
import { appOrigin } from "./hosts.ts";
import { logEvent } from "./log.ts";
import { deleteArtifact, GALLERY, getForConfirmation, updateSettings, type OperationDeps } from "./operations.ts";
import { browserHeaders, plainResponse } from "./serve.ts";

/** A confirmation route: the artifact named in the path and what its page changes. */
export type Confirmation = { readonly id: string; readonly action: "public" | "delete" };

const CONFIRMATION_PATH = /^\/a\/([^/]+)\/(public|delete)$/;

/** The confirmation route `path` names exactly, if any. */
export function confirmationOf(path: string): Confirmation | undefined {
  const match = CONFIRMATION_PATH.exec(path);
  const id = match?.[1];
  const action = match?.[2];
  if (id === undefined || (action !== "public" && action !== "delete")) return undefined;
  return { id, action };
}

/** The methods the confirmation routes take: HEAD as every app-host page, and POST for the form. */
export const CONFIRMATION_METHODS = ["GET", "HEAD", "POST"] as const;

/** RES-1: the form holds at most `public=false`; the bound leaves room for what a browser might add. */
export const CONFIRMATION_FORM_BYTES = 1024;

/** Why a confirmation `POST` was refused, for `confirm.refused` (DATA-1: a closed set). */
export const CONFIRM_REFUSALS = [
  // `Origin` missing, `null`, or another origin than the app host's.
  "origin",
  // `Sec-Fetch-Site` missing or other than `same-origin`.
  "site",
  // Not the page's form: another content type, a body past the bound, or other fields.
  "body",
] as const;
export type ConfirmRefusal = (typeof CONFIRM_REFUSALS)[number];

/**
 * What sets these pages' answers apart from the app host's: never stored, since each shows the state at the moment of
 * the decision, so no page carries `ETag` or `Vary` either; and `Referrer-Policy: same-origin`, since under
 * `no-referrer` a browser sends `Origin: null` on the form's `POST`, which the check refuses. No
 * `Cross-Origin-Opener-Policy`, which would cut the result page off from the window that opened it.
 */
const CONFIRMATION_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin" } as const;

/** Every answer of the confirmation routes, the refusals before this module runs included (405, 403, 503, 500). */
export function withConfirmHeaders(response: Response): Response {
  const answer = new Response(response.body, response);
  for (const [name, value] of Object.entries(CONFIRMATION_HEADERS)) answer.headers.set(name, value);
  return answer;
}

/** The answer and what the page adds to the gallery's CSP. */
export type ConfirmationAnswer = { readonly response: Response; readonly policy?: PagePolicy };

const STATUS: Readonly<Record<OperationErrorCode, number>> = {
  invalid_request: 400,
  not_found: 404,
  version_conflict: 500,
  not_extractable: 500,
  unavailable: 503,
  internal: 500,
};

function failure(status: number): ConfirmationAnswer {
  return { response: plainResponse("private", status) };
}

/** A page, without a validator; a `HEAD` answers the `GET`'s headers without the body. */
function htmlAnswer(request: Request, markup: Markup, policy: PagePolicy): ConfirmationAnswer {
  const body = new TextEncoder().encode(markup.text);
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(body.byteLength),
    ...browserHeaders("private"),
  };
  return { response: new Response(request.method === "HEAD" ? null : body, { headers }), policy };
}

function refused(reason: ConfirmRefusal, status: number): ConfirmationAnswer {
  logEvent("confirm.refused", { reason });
  return failure(status);
}

/** `GET` and `HEAD`: the page for the artifact as it is now, with its one form and Cancel's script. */
async function show(request: Request, confirmation: Confirmation, deps: OperationDeps): Promise<ConfirmationAnswer> {
  const found = await getForConfirmation(deps, { id: confirmation.id });
  if (!found.ok) return failure(STATUS[found.error.code]);
  const page = confirmation.action === "public" ? visibilityPage(found.value) : deletePage(found.value);
  return htmlAnswer(request, page, { forms: {}, script: await scriptSource(CONFIRM_SCRIPT_TEXT) });
}

/** The form's fields, read through the count (RES-1), or the status that refuses the body. */
async function readFields(request: Request): Promise<[string, string][] | 400 | 413> {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return 400;
  const body = await readBytes(request, CONFIRMATION_FORM_BYTES);
  if (!body.ok) return body.reason === "too_large" ? 413 : 400;
  return [...new URLSearchParams(new TextDecoder().decode(body.value))];
}

/** The state `/public`'s form names: exactly one field, `public`, `true` or `false`; undefined for anything else. */
function desiredState(fields: readonly [string, string][]): boolean | undefined {
  const [field, ...rest] = fields;
  if (field === undefined || rest.length > 0 || field[0] !== "public") return undefined;
  return field[1] === "true" ? true : field[1] === "false" ? false : undefined;
}

/** `POST`: the checks of design.md section 10 in its order, then the change and the result page. */
async function decide(request: Request, confirmation: Confirmation, deps: OperationDeps): Promise<ConfirmationAnswer> {
  if (request.headers.get("Origin") !== appOrigin(deps.config)) return refused("origin", 403);
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") return refused("site", 403);
  const fields = await readFields(request);
  if (!Array.isArray(fields)) return refused("body", fields);
  const policy = { script: await scriptSource(RESULT_SCRIPT_TEXT) };
  if (confirmation.action === "delete") {
    // The delete form has no field.
    if (fields.length > 0) return refused("body", 400);
    const deleted = await deleteArtifact(deps, GALLERY, { id: confirmation.id });
    if (!deleted.ok) return failure(STATUS[deleted.error.code]);
    return htmlAnswer(request, resultPage({ change: "deleted", id: deleted.value.deleted }), policy);
  }
  const wanted = desiredState(fields);
  if (wanted === undefined) return refused("body", 400);
  const changed = await updateSettings(deps, GALLERY, { id: confirmation.id, public: wanted });
  if (!changed.ok) return failure(STATUS[changed.error.code]);
  const page = resultPage({ change: wanted ? "public" : "private", artifact: changed.value.artifact });
  return htmlAnswer(request, page, policy);
}

/** Serves a confirmation route for a GET, HEAD or POST that passed Access. */
export function serveConfirmation(
  request: Request,
  confirmation: Confirmation,
  deps: OperationDeps,
): Promise<ConfirmationAnswer> {
  return request.method === "POST" ? decide(request, confirmation, deps) : show(request, confirmation, deps);
}
