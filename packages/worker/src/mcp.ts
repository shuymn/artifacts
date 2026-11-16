/**
 * The MCP adapter at `/mcp` on the API host (design.md section 8, "MCP server"). The router has checked the host
 * (HOST-1) and the bearer token (TOK-1); this module checks the `Origin` (HOST-3), removes the `Authorization` header
 * and builds a stateless `@modelcontextprotocol/server` handler for the request, whose factory closure holds the token
 * name, so the token never reaches the SDK (TOK-2). Each tool decodes its arguments, calls an operation of
 * operations.ts and encodes its result; an operation error is a tool result with `isError: true` and the object REST
 * answers with (P5). Arguments that fail a tool's schema are refused by the SDK, as it forms the refusal.
 */
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { encodeContent, ENCODINGS, decodeContent } from "./encoding.ts";
import { errorBody, type Issue, type OperationError, type Result } from "./errors.ts";
import { apiOrigin } from "./hosts.ts";
import { isArtifactId } from "./id.ts";
import { errorName, logEvent } from "./log.ts";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listVersions,
  lookupFile,
  readFile,
  updateArtifact,
  updateSettings,
  type OperationDeps,
} from "./operations.ts";
import {
  ARCHIVE_SETTINGS,
  archivedFilterSchema,
  archiveSettingSchema,
  contentTypeSchema,
  descriptionSchema,
  filePathSchema,
  LIMITS,
  limitSchema,
  removeSchema,
  titleSchema,
  versionNumberSchema,
} from "./schemas.ts";
import type { TokenName } from "./tokens.ts";

/** design.md section 8, "Server `instructions`", word for word. */
export const INSTRUCTIONS = `This server publishes HTML pages ("artifacts") that the owner opens in a browser. Each artifact has its own origin;
every version needs index.html at its root.

- create_artifact: a title and files. Returns the artifact, version 1 and its URLs. If a create call returns no
  result, call list_artifacts before trying again: the artifact may exist.
- update_artifact: the artifact id and base_version, the latest version you know. Files you send replace or add a
  path, paths in remove are deleted, every other file is kept. On version_conflict, call get_artifact and redo the
  change on top of latest_version.
- Every publish makes a new version that never changes. The latest is at the artifact URL; version n stays at
  <url>/_v/n/.
- Link between an artifact's files with relative URLs (style.css, img/logo.png), percent-encoding each segment (\\ as
  %5C). A root-relative or absolute link to the artifact's own host loads the latest version's file when an older
  version is viewed.
- Text files use encoding "utf8", binary files "base64". The content type follows the extension unless you give
  content_type. Paths are /-separated without empty, "." or ".." segments and do not start with "_v/" or "cdn-cgi/".
- At most 2000 files per version and about 4 MiB per call; for larger files, use the REST API or the CLI.
- Artifacts are visible only to the owner until set_public; a public artifact shows all its versions. Never put
  secrets in an artifact.`;

/** design.md section 6: the most file content `read_file` returns, since tool results go into the model's context. */
export const READ_FILE_BYTES = 1024 * 1024;

// Arguments. Field schemas are the ones REST validates with (schemas.ts), so both adapters refuse the same values.

const idArgument = z.string().describe("The artifact's id.");

/** One file of a publish; the output is the operation's file input, its content decoded to bytes. */
const fileArgument = z
  .strictObject({
    path: filePathSchema.describe('The path in the artifact, such as "index.html" or "img/logo.png".'),
    content: z.string().describe("The file's content in its encoding."),
    encoding: z
      .enum(ENCODINGS)
      .default("utf8")
      .describe('"utf8" for text (the default), "base64" (RFC 4648 with padding, no whitespace) for binary files.'),
    content_type: contentTypeSchema
      .optional()
      .describe("The content type; by default it follows the path's extension."),
  })
  .transform((file, ctx) => {
    const bytes = decodeContent(file.content, file.encoding);
    if (bytes === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message:
          file.encoding === "base64"
            ? "content is not base64 with padding and without whitespace"
            : "content is not well-formed Unicode",
      });
      return z.NEVER;
    }
    return { path: file.path, contentType: file.content_type, body: new Blob([bytes]) };
  });

const filesArgument = z.array(fileArgument).max(LIMITS.files);
const titleArgument = titleSchema.describe("One line, at most 1 KiB of UTF-8.");
const descriptionArgument = descriptionSchema.describe("Any text, at most 16 KiB of UTF-8.");
const limitArgument = limitSchema.describe(`Items per page, ${LIMITS.pageMin} to ${LIMITS.pageMax}; by default 50.`);
const cursorArgument = z.string().describe("The next_cursor of the previous page.");

const createArguments = z.strictObject({
  title: titleArgument,
  description: descriptionArgument.optional(),
  files: filesArgument.describe("The files of version 1; index.html at the root is required."),
});

const updateArguments = z.strictObject({
  id: idArgument,
  base_version: versionNumberSchema.describe("The latest version you know; the update applies only on top of it."),
  title: titleArgument.optional().describe("The new title; by default the base version's."),
  description: descriptionArgument.optional().describe("The new description; by default the base version's."),
  files: filesArgument.optional().describe("Files that replace or add a path."),
  remove: removeSchema.optional().describe("Paths of the base version to delete."),
});

const listArguments = z.strictObject({
  archived: archivedFilterSchema
    .optional()
    .describe("exclude (the default) leaves archived artifacts out, only lists them alone, include lists all."),
  limit: limitArgument.optional(),
  cursor: cursorArgument.optional(),
});

const getArguments = z.strictObject({
  id: idArgument,
  version: versionNumberSchema.optional().describe("The version number; by default the latest."),
});

const listVersionsArguments = z.strictObject({
  id: idArgument,
  limit: limitArgument.optional(),
  cursor: cursorArgument.optional(),
});

const readArguments = z.strictObject({
  id: idArgument,
  version: versionNumberSchema.describe("The version number."),
  path: filePathSchema.describe('The file\'s path in the version, such as "index.html".'),
});

const publicArguments = z.strictObject({
  id: idArgument,
  public: z.boolean().describe("true serves every version at public_url without sign-in; false makes it private."),
});

const archiveArguments = z.strictObject({
  id: idArgument,
  archive: archiveSettingSchema.describe(
    "archived, kept (never archived by age), or null (archived once the latest version is older than the deployment's age).",
  ),
});

const deleteArguments = z.strictObject({ id: idArgument });

// Results: the JSON of design.md section 8, as REST answers it.

const fileResult = z.object({
  path: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  content_type: z.string(),
});

const artifactResult = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  public: z.boolean(),
  archived: z.boolean(),
  archive: z.enum(ARCHIVE_SETTINGS).nullable(),
  latest_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  url: z.string().describe("The latest version's URL."),
  public_url: z.string().nullable().describe("The public URL while the artifact is public."),
  gallery_url: z.string(),
});

const versionResult = z.object({
  number: z.number().int(),
  created_at: z.string(),
  published_by: z.string(),
  title: z.string(),
  description: z.string(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  url: z.string().describe("This version's pinned URL."),
});

const publishResult = z.object({
  artifact: artifactResult,
  version: versionResult.extend({ files: z.array(fileResult) }),
});

const artifactPageResult = z.object({ artifacts: z.array(artifactResult), next_cursor: z.string().nullable() });
const versionPageResult = z.object({ versions: z.array(versionResult), next_cursor: z.string().nullable() });

const readResult = z.object({
  path: z.string(),
  content_type: z.string(),
  size: z.number().int(),
  encoding: z.enum(ENCODINGS),
  content: z.string(),
});

const settingsResult = z.object({ artifact: artifactResult });
const deleteResult = z.object({ deleted: z.string() });

function succeeded(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function failed(body: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

const operationFailed = (error: OperationError) => failed(errorBody(error));

function encode<T extends Record<string, unknown>>(result: Result<T>): CallToolResult {
  return result.ok ? succeeded(result.value) : operationFailed(result.error);
}

/** A thrown error answers `internal` and logs its class only (DATA-1), as the router does for REST. */
function guardTool<A>(run: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await run(args);
    } catch (error) {
      logEvent("request.failed", { error: errorName(error), host: "api" });
      return operationFailed({ code: "internal" });
    }
  };
}

/** The REST route of a file's bytes, each path segment percent-encoded (`\` as `%5C`). */
function restFileUrl(deps: OperationDeps, id: string, version: number, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${apiOrigin(deps.config)}/v1/artifacts/${id}/versions/${version}/files/${encoded}`;
}

/** `read_file`: a file of one version, bounded at READ_FILE_BYTES before its bytes are fetched. */
async function readTool(deps: OperationDeps, args: z.output<typeof readArguments>): Promise<CallToolResult> {
  const { id, version, path } = args;
  if (!isArtifactId(id)) return operationFailed({ code: "not_found" });
  const lookup = await lookupFile(deps, {
    id,
    path: { version, file: path, directory: null },
    publicOnly: false,
  });
  if (!lookup.ok) return operationFailed(lookup.error);
  if (lookup.value.kind !== "file") return operationFailed({ code: "not_found" });
  const file = lookup.value.file;
  if (file.size > READ_FILE_BYTES) {
    const issues: Issue[] = [{ field: "path", reason: "too_large" }];
    const body = errorBody({ code: "invalid_request", issues });
    return failed({ error: { ...body.error, rest_url: restFileUrl(deps, id, version, path) } });
  }
  const bytes = await readFile(deps, id, file);
  if (!bytes.ok) return operationFailed(bytes.error);
  return succeeded({
    path: file.path,
    content_type: file.content_type,
    size: file.size,
    ...encodeContent(bytes.value, file.content_type),
  });
}

/** The server for one request: every tool of design.md section 8, acting as `token`. */
export function createServer(deps: OperationDeps, token: TokenName): McpServer {
  const server = new McpServer(
    { name: "artifacts", version: "0.0.0" },
    {
      instructions: INSTRUCTIONS,
      // The tools never change, so a `subscriptions/listen` stream is acknowledged and closed at once.
      capabilities: { tools: { listChanged: false } },
    },
  );
  const reads = { readOnlyHint: true } as const;

  server.registerTool(
    "create_artifact",
    {
      title: "Create an artifact",
      description: "Publishes a new artifact: version 1 with a title and files, index.html among them.",
      inputSchema: createArguments,
      outputSchema: publishResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guardTool(async (args) => encode(await createArtifact(deps, token, args))),
  );

  server.registerTool(
    "update_artifact",
    {
      title: "Update an artifact",
      description:
        "Publishes a new version on top of base_version: files replace or add paths, remove deletes paths, every other file is kept.",
      inputSchema: updateArguments,
      outputSchema: publishResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guardTool(async (args) =>
      encode(
        await updateArtifact(deps, token, {
          id: args.id,
          baseVersion: args.base_version,
          title: args.title,
          description: args.description,
          files: args.files,
          remove: args.remove,
        }),
      ),
    ),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List artifacts",
      description: "Lists artifacts, most recently updated first, a page at a time.",
      inputSchema: listArguments,
      outputSchema: artifactPageResult,
      annotations: reads,
    },
    guardTool(async (args) => encode(await listArtifacts(deps, args))),
  );

  server.registerTool(
    "get_artifact",
    {
      title: "Get an artifact",
      description: "An artifact and one of its versions (the latest by default) with the version's files.",
      inputSchema: getArguments,
      outputSchema: publishResult,
      annotations: reads,
    },
    guardTool(async (args) => encode(await getArtifact(deps, args))),
  );

  server.registerTool(
    "list_versions",
    {
      title: "List versions",
      description: "An artifact's versions, newest first and without files, a page at a time.",
      inputSchema: listVersionsArguments,
      outputSchema: versionPageResult,
      annotations: reads,
    },
    guardTool(async (args) => encode(await listVersions(deps, args))),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description:
        'A file of one version: encoding "utf8" for textual UTF-8 content, "base64" otherwise. A file over 1 MiB is refused with the REST URL of its bytes.',
      inputSchema: readArguments,
      outputSchema: readResult,
      annotations: reads,
    },
    guardTool(async (args) => readTool(deps, args)),
  );

  server.registerTool(
    "set_public",
    {
      title: "Make public or private",
      description: "Serves every version at public_url without sign-in, or makes the artifact private again.",
      inputSchema: publicArguments,
      outputSchema: settingsResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guardTool(async (args) => encode(await updateSettings(deps, token, { id: args.id, public: args.public }))),
  );

  server.registerTool(
    "set_archive",
    {
      title: "Set the archive setting",
      description: "Archives an artifact, keeps it out of the archive, or leaves it to the age of its latest version.",
      inputSchema: archiveArguments,
      outputSchema: settingsResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guardTool(async (args) => encode(await updateSettings(deps, token, { id: args.id, archive: args.archive }))),
  );

  server.registerTool(
    "delete_artifact",
    {
      title: "Delete an artifact",
      description: "Deletes an artifact and every version; every URL answers 404. Deleting it again succeeds.",
      inputSchema: deleteArguments,
      outputSchema: deleteResult,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guardTool(async (args) => encode(await deleteArtifact(deps, token, args))),
  );

  return server;
}

/** Builds the SDK's handler; tests pass a wrapper that observes what crosses the boundary. */
export type McpHandlerFactory = typeof createMcpHandler;

/**
 * Serves one `/mcp` request after the token check (design.md section 8): a foreign `Origin` answers 403 (HOST-3);
 * otherwise the request goes to the SDK without its `Authorization` header (TOK-2). The SDK answers `GET` and `DELETE`
 * with 405 and a body over 4 MiB, counted as it is read, with 413.
 */
export async function handleMcp(
  request: Request,
  deps: OperationDeps,
  token: TokenName,
  createHandler: McpHandlerFactory = createMcpHandler,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== apiOrigin(deps.config)) {
    return new Response("Forbidden", {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  const handler = createHandler(() => createServer(deps, token), {
    // The SDK reports errors it answered itself; the log carries their class only (DATA-1).
    onerror: (error) => logEvent("request.failed", { error: errorName(error), host: "api" }),
  });
  return handler.fetch(new Request(request, { headers }));
}
