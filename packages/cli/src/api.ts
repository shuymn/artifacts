/**
 * The REST client (design.md section 8). Every request carries the credential's bearer token and a timeout that also
 * bounds reading its answer. A 401 to a stored login's token renews it once and sends the request once more, which is
 * safe because a 401 changes nothing (AC-7). A request that gets no answer fails with `LostResponse`: it may or may not
 * have been applied.
 */
import { CliError, codeOf } from "./errors.ts";
import type { Credential } from "./session.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type Timeouts = {
  /** Every request but a publish and a file of `pull`. */
  readonly requestMs: number;
  /** A publish: up to 32 MiB to upload, then the Worker's R2 and D1 work. */
  readonly publishMs: number;
  /** One file of `pull`, its bytes included. */
  readonly fileMs: number;
  /** How long an export's download may go without a byte; its whole time is not bounded, since it grows with the version. */
  readonly idleMs: number;
};

export const TIMEOUTS: Timeouts = { requestMs: 60_000, publishMs: 600_000, fileMs: 300_000, idleMs: 60_000 };

export type Issue = { readonly field: string; readonly reason: string };

/** An error the API answered with: an operation error or a transport error (design.md section 8, "Errors"). */
export class ApiError extends CliError {
  override readonly name: string = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly issues: readonly Issue[];
  readonly latestVersion: number | undefined;
  /** The paths of a `not_extractable` answer. */
  readonly paths: readonly string[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: readonly Issue[],
    latestVersion?: number,
    paths: readonly string[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.latestVersion = latestVersion;
    this.paths = paths;
  }
}

/** No answer arrived (a network failure or the timeout): the request may or may not have been applied. */
export class LostResponse extends CliError {
  override readonly name: string = "LostResponse";
}

/** A revocation answered with a success other than 204: whether it happened is not confirmed. */
export class UnconfirmedRevocation extends CliError {
  override readonly name: string = "UnconfirmedRevocation";
}

export type FileJson = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly content_type: string;
};

export type ArtifactJson = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly public: boolean;
  readonly archived: boolean;
  readonly archive: string | null;
  readonly latest_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly url: string;
  readonly public_url: string | null;
  readonly gallery_url: string;
};

export type VersionJson = {
  readonly number: number;
  readonly created_at: string;
  readonly published_by: string;
  readonly title: string;
  readonly description: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly url: string;
  readonly files: readonly FileJson[];
};

/**
 * Bounds a request by inactivity instead of a timeout, for an export, whose time grows with the version. `signal` ends
 * the request, and the limit runs only between `start` and `stop`: resolving the credential, a refresh included, is
 * bounded by the refresh's own limits and not counted against it.
 */
export type IdleLimit = {
  readonly signal: AbortSignal;
  /** Rejects with the signal's reason once it aborts, for racing a wait the signal may not end itself. */
  readonly aborted: Promise<never>;
  readonly start: () => void;
  readonly stop: () => void;
};

/** An export's archive: its bytes as a stream, and the length its `Content-Length` announced. */
export type Download = { readonly body: ReadableStream<Uint8Array>; readonly length: number };

/** The answer of a publish or a get: the artifact and one version with its files. */
export type ArtifactVersion = { readonly artifact: ArtifactJson; readonly version: VersionJson };
export type ArtifactPage = { readonly artifacts: readonly ArtifactJson[]; readonly next_cursor: string | null };

/** One OAuth grant of `GET /v1/grants` (design.md section 8, "Grants"). */
export type GrantJson = {
  readonly id: string;
  readonly publisher: string | null;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_host: string | null;
  readonly resource: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
};

type Kind = "string" | "number" | "boolean" | "nullable_string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFields(value: unknown, fields: Readonly<Record<string, Kind>>): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.entries(fields).every(([name, kind]) => {
    const field = value[name];
    return kind === "nullable_string" ? field === null || typeof field === "string" : typeof field === kind;
  });
}

const FILE_FIELDS = { path: "string", size: "number", sha256: "string", content_type: "string" } as const;
const ARTIFACT_FIELDS = {
  id: "string",
  title: "string",
  description: "string",
  public: "boolean",
  archived: "boolean",
  archive: "nullable_string",
  latest_version: "number",
  created_at: "string",
  updated_at: "string",
  url: "string",
  public_url: "nullable_string",
  gallery_url: "string",
} as const;
const VERSION_FIELDS = {
  number: "number",
  created_at: "string",
  published_by: "string",
  title: "string",
  description: "string",
  file_count: "number",
  total_bytes: "number",
  url: "string",
} as const;

const GRANT_FIELDS = {
  id: "string",
  publisher: "nullable_string",
  client_id: "string",
  client_name: "nullable_string",
  redirect_host: "nullable_string",
  resource: "nullable_string",
  created_at: "string",
  expires_at: "nullable_string",
} as const;

function isArtifact(value: unknown): value is ArtifactJson {
  return hasFields(value, ARTIFACT_FIELDS);
}

function isGrant(value: unknown): value is GrantJson {
  return hasFields(value, GRANT_FIELDS);
}

function isVersion(value: unknown): value is VersionJson {
  return (
    hasFields(value, VERSION_FIELDS) &&
    Array.isArray(value.files) &&
    value.files.every((file: unknown) => hasFields(file, FILE_FIELDS))
  );
}

const unexpected = () => new CliError("the API answered in a shape this CLI does not know");

function artifactVersion(value: unknown): ArtifactVersion {
  if (!isRecord(value) || !isArtifact(value.artifact) || !isVersion(value.version)) throw unexpected();
  return { artifact: value.artifact, version: value.version };
}

const readArtifactVersion = async (response: Response) => artifactVersion(await answer(response));

function issuesOf(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((issue: unknown): issue is Issue => hasFields(issue, { field: "string", reason: "string" }));
}

/**
 * The answer's JSON body; an error status becomes an `ApiError`. A 2xx body that breaks off while it is read (a dropped
 * connection, the timeout) fails as it is, so `#call` reports the answer lost: what was applied is unknown. Any other
 * status already tells the outcome, so it fails with that status whether or not its body arrives whole. Only a complete
 * 2xx body that is not JSON is a shape error.
 */
async function answer(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = response.status === 204 ? "" : await response.text();
  } catch (error) {
    if (response.ok) throw error;
    const message = `the API answered ${response.status}, and its body could not be read`;
    throw new ApiError(response.status, `http_${response.status}`, message, []);
  }
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    if (response.ok) throw unexpected();
  }
  if (response.ok) return body;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error?.message === "string" ? error.message : `the API answered ${response.status}`;
  const latest = typeof error?.latest_version === "number" ? error.latest_version : undefined;
  const paths = Array.isArray(error?.paths) ? error.paths.filter((path) => typeof path === "string") : [];
  throw new ApiError(response.status, code, message, issuesOf(error?.issues), latest, paths);
}

/** An archive's answer: its body and announced length, which a cut stream is told from a whole one by. */
async function readDownload(response: Response): Promise<Download> {
  if (!response.ok || response.body === null) {
    await answer(response);
    throw unexpected();
  }
  const declared = response.headers.get("Content-Length") ?? "";
  const type = response.headers.get("Content-Type");
  if (!/^[0-9]{1,15}$/.test(declared) || type !== "application/zip") {
    await response.body.cancel().catch(() => undefined);
    throw declared === ""
      ? new CliError("the API answered without a Content-Length, so a cut archive could not be told from a whole one")
      : unexpected();
  }
  return { body: response.body, length: Number(declared) };
}

export function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** ` (<code>)` for a failed request whose cause carries a system error code (`ECONNREFUSED`, …); otherwise empty. */
export function causeCode(error: unknown): string {
  const code = codeOf(error instanceof Error ? error.cause : undefined);
  return code === undefined ? "" : ` (${code})`;
}

/** The failure of a request that got no answer. Only an error code is kept from the cause, never its text. */
function lost(error: unknown, timeoutMs: number): LostResponse {
  if (isTimeout(error)) return new LostResponse(`the API did not answer within ${timeoutMs / 1000} s`);
  return new LostResponse(`no answer from the API${causeCode(error)}`);
}

const segment = encodeURIComponent;

/** A file path as a URL path: each segment percent-encoded, as the authoring rule asks of links. */
export function encodePath(path: string): string {
  return path.split("/").map(segment).join("/");
}

export type ListQuery = {
  readonly archived: string | undefined;
  readonly limit: number;
  readonly cursor: string | null;
};

export class Api {
  readonly #origin: string;
  readonly #credential: Credential;
  readonly #fetch: Fetch;
  readonly #timeouts: Timeouts;

  constructor(origin: string, credential: Credential, fetch: Fetch, timeouts: Timeouts = TIMEOUTS) {
    this.#origin = origin;
    this.#credential = credential;
    this.#fetch = fetch;
    this.#timeouts = timeouts;
  }

  /**
   * Sends one request and reads its answer, each attempt under `timeoutMs`, or under `idle` when it is given; after a
   * 401, at most once more with the credential's renewed token. The credential is resolved before either limit starts.
   */
  async #call<T>(
    method: string,
    path: string,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
    body?: { readonly content: Blob | string; readonly type: string },
    idle?: IdleLimit,
  ): Promise<T> {
    const send = (token: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = body.type;
      const init: RequestInit = {
        method,
        headers,
        signal: idle?.signal ?? AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      };
      if (body !== undefined) init.body = body.content;
      return this.#fetch(`${this.#origin}${path}`, init);
    };
    /** A wait under `idle`, which ends on its abort even where the fetch would not. */
    const bounded = <R>(wait: Promise<R>): Promise<R> =>
      idle === undefined ? wait : Promise.race([wait, idle.aborted]);
    // A failure of the credential (a refresh) is its own CliError, never a lost answer of this request. A refresh is
    // bounded by its own limits and awaited whole, outside `idle`, so none is left running when the request fails.
    const token = await this.#credential.token();
    try {
      idle?.start();
      let response = await bounded(send(token));
      if (response.status === 401) {
        idle?.stop();
        const renewed = await this.#credential.renew(token);
        idle?.start();
        if (renewed !== undefined) {
          // Not awaited: the refused answer's body is of no use, and its cancel has no bound of its own.
          void response.body?.cancel().catch(() => undefined);
          response = await bounded(send(renewed));
        }
      }
      return await bounded(read(response));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw lost(error, timeoutMs);
    }
  }

  async get(id: string, version?: number): Promise<ArtifactVersion> {
    const path = `/v1/artifacts/${segment(id)}${version === undefined ? "" : `/versions/${version}`}`;
    return this.#call("GET", path, this.#timeouts.requestMs, readArtifactVersion);
  }

  async list(query: ListQuery): Promise<ArtifactPage> {
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.archived !== undefined) params.set("archived", query.archived);
    if (query.cursor !== null) params.set("cursor", query.cursor);
    return this.#call("GET", `/v1/artifacts?${params.toString()}`, this.#timeouts.requestMs, async (response) => {
      const page = await answer(response);
      if (!isRecord(page) || !Array.isArray(page.artifacts) || !page.artifacts.every(isArtifact)) throw unexpected();
      const cursor = page.next_cursor;
      if (cursor === null || typeof cursor === "string") return { artifacts: page.artifacts, next_cursor: cursor };
      throw unexpected();
    });
  }

  /** `POST /v1/artifacts` with a multipart body already encoded. */
  async create(body: Blob, type: string): Promise<ArtifactVersion> {
    return this.#call("POST", "/v1/artifacts", this.#timeouts.publishMs, readArtifactVersion, { content: body, type });
  }

  /** `POST /v1/artifacts/{id}/versions` with a multipart body already encoded. */
  async update(id: string, body: Blob, type: string): Promise<ArtifactVersion> {
    const path = `/v1/artifacts/${segment(id)}/versions`;
    return this.#call("POST", path, this.#timeouts.publishMs, readArtifactVersion, { content: body, type });
  }

  /** `PATCH /v1/artifacts/{id}`; answers `{ artifact }`. */
  async patch(
    id: string,
    settings: { public?: boolean; archive?: string | null },
  ): Promise<{ artifact: ArtifactJson }> {
    return this.#call(
      "PATCH",
      `/v1/artifacts/${segment(id)}`,
      this.#timeouts.requestMs,
      async (response) => {
        const value = await answer(response);
        if (!isRecord(value) || !isArtifact(value.artifact)) throw unexpected();
        return { artifact: value.artifact };
      },
      { content: JSON.stringify(settings), type: "application/json" },
    );
  }

  async delete(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/artifacts/${segment(id)}`, this.#timeouts.requestMs, answer);
  }

  /** `GET /v1/grants`: every grant in one answer, newest first. */
  async grants(): Promise<{ grants: GrantJson[] }> {
    return this.#call("GET", "/v1/grants", this.#timeouts.requestMs, async (response) => {
      const value = await answer(response);
      if (!isRecord(value) || !Array.isArray(value.grants) || !value.grants.every(isGrant)) throw unexpected();
      return { grants: value.grants };
    });
  }

  /** `DELETE /v1/grants/{id}`, under `timeoutMs`. Only a 204 confirms the revocation; any other success fails. */
  async revokeGrant(id: string, timeoutMs: number = this.#timeouts.requestMs): Promise<void> {
    await this.#call("DELETE", `/v1/grants/${segment(id)}`, timeoutMs, async (response) => {
      if (!response.ok || response.status === 204) return answer(response);
      await response.body?.cancel().catch(() => undefined);
      throw new UnconfirmedRevocation(
        `the API answered ${response.status} instead of 204, so the revocation is not confirmed`,
      );
    });
  }

  /**
   * The bytes of one file as a stream. The request's timeout keeps running while the stream is read: a read past it
   * fails with the timeout's `DOMException`.
   */
  async file(id: string, version: number, path: string): Promise<ReadableStream<Uint8Array>> {
    const route = `/v1/artifacts/${segment(id)}/versions/${version}/files/${encodePath(path)}`;
    return this.#call("GET", route, this.#timeouts.fileMs, async (response) => {
      if (response.ok && response.body !== null) return response.body;
      await answer(response);
      throw unexpected();
    });
  }

  /**
   * `GET …/versions/{n}/export` (design.md section 8, "Export"): the archive as a stream and the length its
   * `Content-Length` announces, under `idle` in place of a timeout. `idle` still runs when this answers, and its signal
   * ends the body.
   */
  async exportArchive(id: string, version: number, idle: IdleLimit): Promise<Download> {
    const route = `/v1/artifacts/${segment(id)}/versions/${version}/export`;
    return this.#call("GET", route, this.#timeouts.idleMs, readDownload, undefined, idle);
  }
}
