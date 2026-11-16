import { describe, expect, it } from "vitest";

import exampleText from "../wrangler.deploy.example.jsonc?raw";
import wranglerText from "../wrangler.jsonc?raw";

declare global {
  interface ImportMeta {
    glob<T>(patterns: string | string[], options: { query: string; import: string; eager: true }): Record<string, T>;
  }
}

// Non-test sources of the Worker. test-support.ts and test-setup.ts serve tests only.
const sources = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts", "!./test-support.ts", "!./test-setup.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** JSONC without comments and trailing commas, as wrangler reads it. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const end = text.indexOf('"', i + 1);
      let close = end;
      while (text[close - 1] === "\\") close = text.indexOf('"', close + 1);
      out += text.slice(i, close + 1);
      i = close;
    } else if (char === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i) - 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// DATA-1: only log.ts writes to the console, with fields from closed sets.
describe("DATA-1: the logging sink", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources)).toContain("./log.ts");
    expect(Object.keys(sources)).toContain("./index.ts");
  });

  it("uses console only in log.ts", () => {
    const users = Object.entries(sources)
      .filter(([, text]) => /\bconsole\b/.test(text))
      .map(([file]) => file);
    expect(users).toEqual(["./log.ts"]);
  });
});

// PL-31, DATA-2, HOST-1: the public configuration holds no deployment value.
describe("DATA-2: wrangler.jsonc", () => {
  const config = parseJsonc(wranglerText);

  it("sets no variable, route, account or resource identifier", () => {
    for (const key of ["vars", "routes", "route", "account_id", "zone_id", "zone_name", "env"]) {
      expect(config).not.toHaveProperty(key);
    }
    expect(config).toHaveProperty("d1_databases", [{ binding: "DB", migrations_dir: "migrations" }]);
    expect(config).toHaveProperty("r2_buckets", [{ binding: "FILES" }]);
    // PL-48: the namespace's ID is a deployment value.
    expect(config).toHaveProperty("kv_namespaces", [{ binding: "OAUTH_KV" }]);
  });

  // OAUTH-6: the OAuth library's fetches of client documents stay on public addresses.
  it("sets global_fetch_strictly_public", () => {
    expect(config).toHaveProperty("compatibility_flags", ["global_fetch_strictly_public"]);
  });

  it("is reachable only on its routes and keeps invocation logs off", () => {
    expect(config).toHaveProperty("workers_dev", false);
    expect(config).toHaveProperty("preview_urls", false);
    expect(config).toHaveProperty("observability.logs.invocation_logs", false);
  });
});

// PL-31, DATA-2: the committed example of the deployment values holds placeholders only, and no secret.
describe("DATA-2: wrangler.deploy.example.jsonc", () => {
  const example = parseJsonc(exampleText);

  it("leaves every identifier and Access value empty and holds no token", () => {
    expect(example).toHaveProperty("account_id", "");
    expect(example).toHaveProperty("d1_databases", [{ binding: "DB", database_name: "", database_id: "" }]);
    expect(example).toHaveProperty("r2_buckets", [{ binding: "FILES", bucket_name: "" }]);
    expect(example).toHaveProperty("kv_namespaces", [{ binding: "OAUTH_KV", id: "" }]);
    for (const variable of ["ACCESS_TEAM_DOMAIN", "ACCESS_APP_AUD", "ACCESS_CONTENT_AUD"]) {
      expect(example).toHaveProperty(["vars", variable], "");
    }
    expect(example).not.toHaveProperty("vars.API_TOKENS");
  });

  it("names only example hosts", () => {
    const hosts = /[a-z0-9*-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|dev|io|app)\b/g;
    const found = [...exampleText.matchAll(hosts)].map(([host]) => host);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.filter((host) => !/(?:^|[.*-])example(?:-content)?\.(?:com|net)$|\.cloudflareaccess\.com$/.test(host)),
    ).toEqual([]);
  });
});
