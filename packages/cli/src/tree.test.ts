// PL-30: the directory mapping of design.md section 9, checked on real file trees.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { tempDir, writeTree } from "./test-support.ts";
import { LIMITS, localFiles, pathProblem } from "./tree.ts";

async function paths(input: string): Promise<string[]> {
  return (await localFiles(input)).map((file) => file.path).toSorted();
}

describe("directory mapping", () => {
  it("publishes every regular file by its relative path and skips names starting with a dot", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "index.html": "<p>hi</p>",
      "css/site.css": "body{}",
      "img/a/b.png": new Uint8Array([137, 80, 78, 71]),
      ".env": "SECRET=1",
      ".git/config": "[core]",
      "css/.cache": "x",
      ".hidden/page.html": "x",
    });
    expect(await paths(root)).toEqual(["css/site.css", "img/a/b.png", "index.html"]);
  });

  it("publishes a linked directory and file under the link's path as well as the target's", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "index.html": "x",
      "real/style.css": "a{}",
      "real/deep/x.js": "1",
      alias: { link: "real" },
      "top.css": { link: "real/style.css" },
    });
    expect(await paths(root)).toEqual([
      "alias/deep/x.js",
      "alias/style.css",
      "index.html",
      "real/deep/x.js",
      "real/style.css",
      "top.css",
    ]);
    const files = await localFiles(root);
    const source = (path: string) => files.find((file) => file.path === path)?.source;
    expect(source("alias/style.css")).toBe(source("real/style.css"));
  });

  it("refuses a link that leaves the directory, relative or absolute", async () => {
    const outside = await tempDir();
    await writeTree(outside, { "secret.txt": "s" });
    const relativeRoot = await tempDir();
    await writeTree(relativeRoot, { "index.html": "x", "sub/out": { link: join("..", "..", basename(outside)) } });
    await expect(localFiles(relativeRoot)).rejects.toThrow('the link "sub/out" leaves the directory');
    const absoluteRoot = await tempDir();
    await writeTree(absoluteRoot, { "index.html": "x", "secret.txt": { link: join(outside, "secret.txt") } });
    await expect(localFiles(absoluteRoot)).rejects.toThrow('the link "secret.txt" leaves the directory');
  });

  it("refuses a link to a directory on its own path (a loop)", async () => {
    const toRoot = await tempDir();
    await writeTree(toRoot, { "index.html": "x", "a/b/up": { link: "../.." } });
    await expect(localFiles(toRoot)).rejects.toThrow('the link "a/b/up" points to ".", above itself (a loop)');
    const toParent = await tempDir();
    await writeTree(toParent, { "index.html": "x", "a/b/up": { link: ".." } });
    await expect(localFiles(toParent)).rejects.toThrow('the link "a/b/up" points to "a", above itself (a loop)');
    // Two links that reach each other's directory: a loop through an alias.
    const mutual = await tempDir();
    await writeTree(mutual, { "index.html": "x", "x/to-y": { link: "../y" }, "y/to-x": { link: "../x" } });
    await expect(localFiles(mutual)).rejects.toThrow("(a loop)");
  });

  it("refuses a broken link", async () => {
    const root = await tempDir();
    await writeTree(root, { "index.html": "x", gone: { link: "missing.css" } });
    await expect(localFiles(root)).rejects.toThrow('the link "gone" is broken');
  });

  it("publishes NFD names in NFC", async () => {
    const root = await tempDir();
    const nfd = "café.css";
    await writeTree(root, { "index.html": "x", [nfd]: "a{}" });
    expect(await paths(root)).toEqual(["café.css".normalize("NFC"), "index.html"]);
    expect((await paths(root)).includes(nfd)).toBe(false);
  });

  // macOS file systems treat the two spellings as one name, so only other systems can hold both.
  it.skipIf(process.platform === "darwin")("refuses two names that are equal in NFC", async () => {
    const root = await tempDir();
    await writeTree(root, { "index.html": "x", "café.css": "a", "café.css": "b" });
    await expect(localFiles(root)).rejects.toThrow("two files map to the path");
  });

  it("refuses a directory without index.html at its root", async () => {
    const root = await tempDir();
    await writeTree(root, { "sub/index.html": "x", "page.html": "x" });
    await expect(localFiles(root)).rejects.toThrow("every version needs index.html at its root");
  });

  it("refuses paths whose first segment is _v or cdn-cgi", async () => {
    for (const reserved of ["_v/1/index.html", "cdn-cgi/x.js"]) {
      const root = await tempDir();
      await writeTree(root, { "index.html": "x", [reserved]: "x" });
      await expect(localFiles(root)).rejects.toThrow('paths may not start with "_v/" or "cdn-cgi/"');
    }
    const nested = await tempDir();
    await writeTree(nested, { "index.html": "x", "a/_v/x": "x", "a/cdn-cgi/y": "y" });
    expect(await paths(nested)).toEqual(["a/_v/x", "a/cdn-cgi/y", "index.html"]);
  });

  it("bounds a path at 1 KiB of UTF-8", () => {
    const at = `${"é".repeat(511)}ab`;
    expect(Buffer.byteLength(at)).toBe(LIMITS.pathBytes);
    expect(pathProblem(at)).toBeUndefined();
    expect(pathProblem(`${at}c`)).toBe("paths are at most 1024 bytes of UTF-8");
  });

  it("takes 2000 files and refuses one more before reading any", async () => {
    const root = await tempDir();
    await writeFile(join(root, "index.html"), "x");
    await mkdir(join(root, "f"));
    for (let i = 1; i < LIMITS.files; i++) await writeFile(join(root, "f", String(i)), "");
    expect((await localFiles(root)).length).toBe(LIMITS.files);
    await writeFile(join(root, "f", "extra"), "");
    await expect(localFiles(root)).rejects.toThrow("more than 2000 files to publish");
  });

  it("publishes a single HTML file as index.html and refuses any other single file", async () => {
    const root = await tempDir();
    await writeTree(root, { "report.html": "<h1>r</h1>", "OLD.HTM": "x", "notes.txt": "n" });
    expect(await localFiles(join(root, "report.html"))).toEqual([
      { path: "index.html", source: expect.stringMatching(/report\.html$/), size: 10 },
    ]);
    expect(await paths(join(root, "OLD.HTM"))).toEqual(["index.html"]);
    await expect(localFiles(join(root, "notes.txt"))).rejects.toThrow("a single file must be an HTML file");
  });
});
