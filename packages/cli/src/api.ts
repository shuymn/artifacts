/**
 * The REST client (design.md section 8). Every request carries the bearer token and a timeout that also bounds reading
 * its answer. A request that gets no answer fails with `LostResponse`: it may or may not have been applied.
 */
import type { Config } from "./config.ts";
import { CliError } from "./errors.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type Timeouts = {
  /** Every request but a publish and a file of `pull`. */
  readonly requestMs: number;
  /** A publish: up to 32 MiB to upload, then the Worker's R2 and D1 work. */
  readonly publishMs: number;
  /** One file of `pull`, its bytes included. */
  readonly fileMs: number;
};

export const TIMEOUTS: Timeouts = { requestMs: 60_000, publishMs: 600_000, fileMs: 300_000 };

export type Issue = { readonly field: string; readonly reason: string };

/** An error the API answered with: an operation error or a transport error (design.md section 8, "Errors"). */
export class ApiError extends CliError {
  override readonly name: string = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly issues: readonly Issue[];
  readonly latestVersion: number | undefined;

  constructor(status: number, code: string, message: string, issues: readonly Issue[], latestVersion?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.latestVersion = latestVersion;
  }
}

/** No answer arrived (a network failure or the timeout): the request may or may not have been applied. */
export class LostResponse extends CliError {
  override readonly name: string = "LostResponse";
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

/** The answer of a publish or a get: the artifact and one version with its files. */
export type ArtifactVersion = { readonly artifact: ArtifactJson; readonly version: VersionJson };
export type ArtifactPage = { readonly artifacts: readonly ArtifactJson[]; readonly next_cursor: string | null };

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

function isArtifact(value: unknown): value is ArtifactJson {
  return hasFields(value, ARTIFACT_FIELDS);
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

/** The answer's JSON body; an error status becomes an `ApiError`. */
async function answer(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
  } catch (error) {
    if (isTimeout(error)) throw error;
    if (response.ok) throw unexpected();
  }
  if (response.ok) return body;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error?.message === "string" ? error.message : `the API answered ${response.status}`;
  const latest = typeof error?.latest_version === "number" ? error.latest_version : undefined;
  throw new ApiError(response.status, code, message, issuesOf(error?.issues), latest);
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The failure of a request that got no answer. Only an error code is kept from the cause, never its text. */
function lost(error: unknown, timeoutMs: number): LostResponse {
  if (isTimeout(error)) return new LostResponse(`the API did not answer within ${timeoutMs / 1000} s`);
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause.code === "string" ? ` (${cause.code})` : "";
  return new LostResponse(`no answer from the API${code}`);
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
  readonly #config: Config;
  readonly #fetch: Fetch;
  readonly #timeouts: Timeouts;

  constructor(config: Config, fetch: Fetch, timeouts: Timeouts = TIMEOUTS) {
    this.#config = config;
    this.#fetch = fetch;
    this.#timeouts = timeouts;
  }

  /** Sends one request and reads its answer, both under `timeoutMs`. */
  async #call<T>(
    method: string,
    path: string,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
    body?: { readonly content: Blob | string; readonly type: string },
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#config.token}` };
    if (body !== undefined) headers["Content-Type"] = body.type;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" };
    if (body !== undefined) init.body = body.content;
    try {
      return await read(await this.#fetch(`${this.#config.apiOrigin}${path}`, init));
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
}
