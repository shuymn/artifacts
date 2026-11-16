import { describe, expect, it } from "vitest";

import { parseConfig, type ConfigInput } from "./config.ts";
import { classifyHost } from "./hosts.ts";
import { isArtifactId, newArtifactId } from "./id.ts";

const HASH = "a".repeat(64);
const SHARED_DOMAIN: ConfigInput = {
  APP_HOST: "artifacts.example.com",
  API_HOST: "artifacts-api.example.com",
  CONTENT_HOST_SUFFIX: "-art.example.com",
  PUBLIC_HOST_SUFFIX: "-pub.example.com",
  ARCHIVE_AFTER_DAYS: "30",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_APP_AUD: "app-aud",
  ACCESS_CONTENT_AUD: "content-aud",
  API_TOKENS: JSON.stringify({ codex: HASH }),
};
const CONTENT_DOMAIN: ConfigInput = {
  ...SHARED_DOMAIN,
  CONTENT_HOST_SUFFIX: "-p.example-content.net",
  PUBLIC_HOST_SUFFIX: "-s.example-content.net",
};
const LOCAL: ConfigInput = {
  APP_HOST: "app.localhost:8787",
  API_HOST: "api.localhost:8787",
  CONTENT_HOST_SUFFIX: "-art.localhost:8787",
  PUBLIC_HOST_SUFFIX: "-pub.localhost:8787",
  ARCHIVE_AFTER_DAYS: 30,
  API_TOKENS: "{}",
};

describe("parseConfig", () => {
  it("accepts both layouts, with Access verified", () => {
    for (const input of [SHARED_DOMAIN, CONTENT_DOMAIN]) {
      const parsed = parseConfig(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.config.access).toEqual({
        teamDomain: "team.cloudflareaccess.com",
        appAud: "app-aud",
        contentAud: "content-aud",
      });
      expect(parsed.config.scheme).toBe("https");
      expect(parsed.config.oauth).toBe(true);
      expect(parsed.config.archiveAfterMs).toBe(30 * 86_400_000);
    }
  });

  // ACC-2: Access is skipped only when every configured host is a localhost name; OAuth is off there (PL-47).
  it("skips Access and turns OAuth off only for an all-localhost configuration", () => {
    const parsed = parseConfig(LOCAL);
    expect(parsed).toMatchObject({ ok: true, config: { access: null, oauth: false, scheme: "http" } });
  });

  it("takes the team domain as a host or an https URL", () => {
    const parsed = parseConfig({ ...SHARED_DOMAIN, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/" });
    expect(parsed).toMatchObject({ ok: true, config: { access: { teamDomain: "team.cloudflareaccess.com" } } });
  });

  // PL-2, HOST-2, ACC-2: one case per refusal.
  it.each<[string, ConfigInput, string, string | undefined]>([
    [
      "a public suffix ending with the content suffix",
      { CONTENT_HOST_SUFFIX: ".example-content.net", PUBLIC_HOST_SUFFIX: "-s.example-content.net" },
      "public_suffix_under_content",
      "PUBLIC_HOST_SUFFIX",
    ],
    ["equal suffixes", { PUBLIC_HOST_SUFFIX: "-art.example.com" }, "public_suffix_under_content", "PUBLIC_HOST_SUFFIX"],
    ["an app host under the content suffix", { APP_HOST: "gallery-art.example.com" }, "host_under_suffix", "APP_HOST"],
    ["an app host under the public suffix", { APP_HOST: "x-pub.example.com" }, "host_under_suffix", "APP_HOST"],
    ["an API host under the content suffix", { API_HOST: "api-art.example.com" }, "host_under_suffix", "API_HOST"],
    ["an API host under the public suffix", { API_HOST: "api-pub.example.com" }, "host_under_suffix", "API_HOST"],
    [
      "a content suffix making a 64-character label",
      { CONTENT_HOST_SUFFIX: `-${"a".repeat(37)}.example.com` },
      "label_too_long",
      "CONTENT_HOST_SUFFIX",
    ],
    [
      "a public suffix making a 64-character label",
      { PUBLIC_HOST_SUFFIX: `-${"b".repeat(37)}.example.com` },
      "label_too_long",
      "PUBLIC_HOST_SUFFIX",
    ],
    ["a localhost app host among others", { APP_HOST: "app.localhost:8787" }, "localhost_mixed", undefined],
    ["a localhost API host among others", { API_HOST: "localhost" }, "localhost_mixed", undefined],
    [
      "a localhost content suffix among others",
      { CONTENT_HOST_SUFFIX: "-art.localhost:8787" },
      "localhost_mixed",
      undefined,
    ],
    ["equal app and API hosts", { API_HOST: "artifacts.example.com" }, "hosts_not_distinct", "API_HOST"],
    ["a shared Access audience", { ACCESS_CONTENT_AUD: "app-aud" }, "access_aud_shared", "ACCESS_CONTENT_AUD"],
  ])("refuses %s", (_name, change, code, variable) => {
    const parsed = parseConfig({ ...SHARED_DOMAIN, ...change });
    expect(parsed).toEqual(variable === undefined ? { ok: false, code } : { ok: false, code, variable });
  });

  it("accepts a suffix label part of 37 characters, making a 63-character label", () => {
    expect(parseConfig({ ...SHARED_DOMAIN, CONTENT_HOST_SUFFIX: `-${"a".repeat(36)}.example.com` }).ok).toBe(true);
  });

  it.each<[keyof ConfigInput, unknown, string]>([
    ["APP_HOST", undefined, "missing"],
    ["APP_HOST", "", "missing"],
    ["APP_HOST", "Artifacts.example.com", "invalid"],
    ["APP_HOST", "https://artifacts.example.com", "invalid"],
    ["APP_HOST", "artifacts.example.com/", "invalid"],
    ["API_HOST", "-api.example.com", "invalid"],
    ["CONTENT_HOST_SUFFIX", "art.example.com", "invalid"],
    ["CONTENT_HOST_SUFFIX", "-.example.com", "invalid"],
    ["CONTENT_HOST_SUFFIX", "-art-.example.com", "invalid"],
    ["PUBLIC_HOST_SUFFIX", "-pub", "invalid"],
    ["ARCHIVE_AFTER_DAYS", undefined, "missing"],
    ["ARCHIVE_AFTER_DAYS", "0", "invalid"],
    ["ARCHIVE_AFTER_DAYS", "030", "invalid"],
    ["ARCHIVE_AFTER_DAYS", "1.5", "invalid"],
    ["ARCHIVE_AFTER_DAYS", "36501", "invalid"],
    ["ARCHIVE_AFTER_DAYS", 0, "invalid"],
    ["ACCESS_TEAM_DOMAIN", undefined, "missing"],
    ["ACCESS_TEAM_DOMAIN", "http://team.cloudflareaccess.com", "invalid"],
    ["ACCESS_APP_AUD", undefined, "missing"],
    ["ACCESS_CONTENT_AUD", "has space", "invalid"],
    ["API_TOKENS", undefined, "missing"],
    ["API_TOKENS", "not json", "invalid"],
    ["API_TOKENS", "[]", "invalid"],
    ["API_TOKENS", JSON.stringify({ Codex: HASH }), "invalid"],
    ["API_TOKENS", JSON.stringify({ codex: "A".repeat(64) }), "invalid"],
    ["API_TOKENS", JSON.stringify({ codex: HASH.slice(1) }), "invalid"],
    ["API_TOKENS", JSON.stringify({ ["n".repeat(33)]: HASH }), "invalid"],
    ["API_TOKENS", JSON.stringify({ codex: HASH, claude: HASH }), "invalid"],
  ])("refuses %s = %j as %s", (variable, value, code) => {
    expect(parseConfig({ ...SHARED_DOMAIN, [variable]: value })).toEqual({ ok: false, code, variable });
  });

  it("parses API_TOKENS into names and hash bytes", () => {
    const parsed = parseConfig({ ...SHARED_DOMAIN, API_TOKENS: JSON.stringify({ "agent-1": "0f".repeat(32) }) });
    expect(parsed.ok && parsed.config.tokens).toEqual([{ name: "agent-1", hash: new Uint8Array(32).fill(15) }]);
  });
});

// PL-1, HOST-1: exact classification.
describe("classifyHost", () => {
  const parsed = parseConfig(SHARED_DOMAIN);
  if (!parsed.ok) throw new Error("the shared-domain configuration is invalid");
  const { config } = parsed;
  const id = "abcdefghijklmnopqrstuvwxyz";

  it.each([
    ["artifacts.example.com", { kind: "app" }],
    ["artifacts-api.example.com", { kind: "api" }],
    [`${id}-art.example.com`, { kind: "content", id }],
    [`${id}-pub.example.com`, { kind: "public", id }],
    [`234567${id.slice(6)}-art.example.com`, { kind: "content", id: `234567${id.slice(6)}` }],
  ])("classifies %s", (host, route) => {
    expect(classifyHost(host, config)).toEqual(route);
  });

  it.each([
    ["an extra label", `x.${id}-art.example.com`],
    ["an extra label on the app host", "www.artifacts.example.com"],
    ["uppercase letters", `${id.toUpperCase()}-art.example.com`],
    ["an uppercase app host", "Artifacts.example.com"],
    ["a 25-character prefix", `${id.slice(1)}-art.example.com`],
    ["a 27-character prefix", `${id}a-art.example.com`],
    ["a port", `${id}-art.example.com:8443`],
    ["a port on the app host", "artifacts.example.com:443"],
    ["a hyphen in the ID", `abcdefghijklm-opqrstuvwxyz-art.example.com`],
    ["characters outside the alphabet", `abcdefghijklmnopqrstuvwxy1-art.example.com`],
    ["the bare suffix", "-art.example.com"],
    ["another domain", `${id}-art.example.org`],
    ["the zone apex", "example.com"],
  ])("leaves a host with %s unmatched", (_name, host) => {
    expect(classifyHost(host, config)).toEqual({ kind: "unmatched" });
  });

  it("classifies hosts with ports in a localhost configuration", () => {
    const local = parseConfig(LOCAL);
    if (!local.ok) throw new Error("the local configuration is invalid");
    expect(classifyHost(`${id}-art.localhost:8787`, local.config)).toEqual({ kind: "content", id });
    expect(classifyHost(`${id}-art.localhost`, local.config)).toEqual({ kind: "unmatched" });
  });
});

// ISO-1: IDs are 26 characters of lowercase base32.
describe("newArtifactId", () => {
  it("makes valid, distinct IDs over the whole alphabet", () => {
    const ids = Array.from({ length: 200 }, () => newArtifactId());
    expect(ids.every(isArtifactId)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids.join("")).size).toBe(32);
  });
});
