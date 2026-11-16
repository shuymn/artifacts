/**
 * The release binaries' platforms and archive names (docs/operations.md, "How a change reaches the deployment"). Each
 * platform's archive holds the binary at its root; the names carry the OS, architecture and libc that mise's github
 * backend picks an asset by.
 */
import { join } from "node:path";

export const PLATFORMS = ["darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "windows-x64-msvc"] as const;
export type Platform = (typeof PLATFORMS)[number];

const HOSTS: Readonly<Record<string, Platform>> = {
  "darwin arm64": "darwin-arm64",
  // Linux hosts are taken to be glibc, as the release runners are; a binary built on musl would be misnamed.
  "linux x64": "linux-x64-gnu",
  "linux arm64": "linux-arm64-gnu",
  "win32 x64": "windows-x64-msvc",
};

export function binaryName(platform: Platform): string {
  return platform === "windows-x64-msvc" ? "artifacts.exe" : "artifacts";
}

export function archiveName(tag: string, platform: Platform): string {
  return `artifacts-${tag}-${platform}.${platform === "windows-x64-msvc" ? "zip" : "tar.gz"}`;
}

/** The tar that reads and writes the host's archive format: on Windows its own, which handles zip. */
export function tarCommand(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

export type Target = { readonly tag: string; readonly platform: Platform };

/**
 * The tag and platform a build makes: `v` and the root package's version, on the host's platform. A release names its
 * tag and platform too, and the build refuses either when it differs, so a binary never carries another version or
 * lands in another platform's archive.
 */
export function target(input: {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly releaseTag?: string | undefined;
  readonly releasePlatform?: string | undefined;
}): Target {
  const tag = `v${input.version}`;
  if (input.releaseTag !== undefined && input.releaseTag !== tag) {
    throw new Error(`the release tag ${input.releaseTag} is not the root package's version, ${tag}`);
  }
  const host = `${input.os} ${input.arch}`;
  const platform = Object.hasOwn(HOSTS, host) ? HOSTS[host] : undefined;
  if (platform === undefined) throw new Error(`no release binary is built on ${input.os} ${input.arch}`);
  if (input.releasePlatform !== undefined && input.releasePlatform !== platform) {
    throw new Error(`this host builds ${platform}, not ${input.releasePlatform}`);
  }
  return { tag, platform };
}
