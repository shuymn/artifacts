/**
 * `pull` (design.md section 9): writes every file of a version into a new or empty directory, so that a later
 * `publish --id` from it reproduces the version. Files are created exclusively and checked against their listed size
 * and SHA-256; a file that fails is removed, and the files written before it stay.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Api, ArtifactVersion, FileJson } from "./api.ts";
import { CliError } from "./errors.ts";

/** The segments of a listed path, refused unless each is a plain name (the Worker never lists another). */
function segmentsOf(path: string): string[] {
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\0"))) {
    throw new CliError(`the version lists a path that cannot be written: ${JSON.stringify(path)}`);
  }
  return segments;
}

/** A path that is both a file and a directory of another path cannot exist in a file system. */
function refuseClashes(files: readonly FileJson[]): void {
  const paths = new Set(files.map((file) => file.path));
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join("/");
      if (paths.has(directory)) {
        throw new CliError(
          `the version has a file ${JSON.stringify(directory)} and a file below it, ${JSON.stringify(path)}; ` +
            "a directory cannot hold both",
        );
      }
    }
  }
}

/** Creates `directory` or accepts it when empty. */
async function prepare(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (codeOf(error) !== "ENOENT")
      throw new CliError(`cannot use ${JSON.stringify(directory)} as the target directory`);
    await mkdir(directory, { recursive: true });
    return;
  }
  if (entries.length > 0) throw new CliError(`${JSON.stringify(directory)} is not empty; pull into a new directory`);
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** The chunks of a download; a read that fails or passes the request's timeout ends the pull. */
async function* download(body: ReadableStream<Uint8Array>, shown: string): AsyncGenerator<Uint8Array> {
  try {
    yield* body;
  } catch (error) {
    throw new CliError(
      error instanceof DOMException
        ? `the download of ${shown} did not finish in time`
        : `the download of ${shown} broke off`,
    );
  }
}

async function writeFile(api: Api, id: string, version: number, file: FileJson, target: string): Promise<void> {
  const shown = JSON.stringify(file.path);
  // `wx` creates the file or fails, so nothing existing is overwritten and no link is followed.
  const handle = await open(target, "wx").catch((error: unknown) => {
    throw new CliError(
      codeOf(error) === "EEXIST"
        ? `cannot write ${shown}: another file of the version has the same name in this file system`
        : `cannot write ${shown} (${codeOf(error) ?? "error"})`,
    );
  });
  let complete = false;
  try {
    const body = await api.file(id, version, file.path);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of download(body, shown)) {
      hash.update(chunk);
      size += chunk.byteLength;
      // writeFile on a handle writes the whole chunk at the current position.
      await handle.writeFile(chunk).catch((error: unknown) => {
        throw new CliError(`cannot write ${shown} (${codeOf(error) ?? "error"})`);
      });
    }
    if (size !== file.size || hash.digest("hex") !== file.sha256) {
      throw new CliError(`the bytes of ${shown} differ from the version's listing`);
    }
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(target).catch(() => undefined);
  }
}

export type Pulled = ArtifactVersion & { readonly dotNames: readonly string[] };

export async function pull(api: Api, id: string, directory: string, version: number | undefined): Promise<Pulled> {
  const result = await api.get(id, version);
  const files = result.version.files;
  const targets = files.map((file) => ({ file, target: join(directory, ...segmentsOf(file.path)) }));
  refuseClashes(files);
  await prepare(directory);
  for (const { file, target } of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(api, id, result.version.number, file, target);
  }
  const dotNames = files.map((file) => file.path).filter((path) => path.split("/").some((s) => s.startsWith(".")));
  return { ...result, dotNames };
}
