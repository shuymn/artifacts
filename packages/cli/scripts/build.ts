/**
 * Builds this host's release archive (scripts/release.ts): `bun build --compile` of src/main.ts into dist/<platform>/,
 * then dist/artifacts-v<version>-<platform>.tar.gz (or .zip) with the binary at its root, and prints the archive's
 * path. Run it with Bun: the Bun running it is the runtime compiled into the binary, so nothing is downloaded for
 * another target. RELEASE_TAG and RELEASE_PLATFORM, when set, must be the tag and platform it builds.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import rootPackage from "../../../package.json" with { type: "json" };
import { archiveName, binaryName, tarCommand, target } from "./release.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(PACKAGE, "dist");

const { tag, platform } = target({
  version: rootPackage.version,
  os: process.platform,
  arch: process.arch,
  releaseTag: process.env.RELEASE_TAG || undefined,
  releasePlatform: process.env.RELEASE_PLATFORM || undefined,
});
const stage = join(DIST, platform);
const name = binaryName(platform);
const binary = join(stage, name);
const archive = join(DIST, archiveName(tag, platform));

const run = (file: string, args: readonly string[], options: ExecFileSyncOptions = {}) =>
  execFileSync(file, args, { cwd: PACKAGE, stdio: "inherit", ...options });

const signed = (path: string) => {
  try {
    run("codesign", ["--verify", "--strict", path]);
    return true;
  } catch {
    return false;
  }
};

await rm(stage, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(stage, { recursive: true });

// The binary reads neither a .env nor a bunfig.toml from the directory it runs in.
run(process.execPath, [
  "build",
  "src/main.ts",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--outfile",
  binary,
]);

// macOS on arm64 runs only signed code. Bun signs its output ad hoc; sign it here only if that signature is not valid.
if (platform === "darwin-arm64" && !signed(binary)) {
  run("codesign", ["--force", "--sign", "-", binary]);
  if (!signed(binary)) throw new Error("the binary's ad-hoc signature is not valid");
}

// The archive carries no extended attributes (macOS marks the binary with com.apple.provenance): --no-xattrs leaves
// them out of the entry's headers, and COPYFILE_DISABLE keeps macOS's tar from adding an AppleDouble (._) entry.
const tarArgs = platform === "windows-x64-msvc" ? ["-a", "-cf"] : ["--no-xattrs", "-czf"];
run(tarCommand(), [...tarArgs, archive, "-C", stage, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(archive);
