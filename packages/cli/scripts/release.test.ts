// The checks that keep a release binary's version and platform those of its release.
import { describe, expect, it } from "vitest";

import { target } from "./release.ts";

describe("target", () => {
  it("builds v<version> for the host, and refuses a release whose tag or platform differs", () => {
    const host = { version: "1.2.3", os: "linux", arch: "arm64" };
    expect(target(host)).toEqual({ tag: "v1.2.3", platform: "linux-arm64-gnu" });
    expect(target({ ...host, releaseTag: "v1.2.3", releasePlatform: "linux-arm64-gnu" })).toEqual({
      tag: "v1.2.3",
      platform: "linux-arm64-gnu",
    });
    expect(() => target({ ...host, releaseTag: "v1.2.4" })).toThrow("the release tag v1.2.4 is not");
    expect(() => target({ ...host, releasePlatform: "linux-x64-gnu" })).toThrow("this host builds linux-arm64-gnu");
    expect(() => target({ ...host, os: "darwin", arch: "x64" })).toThrow("no release binary is built on darwin x64");
  });
});
