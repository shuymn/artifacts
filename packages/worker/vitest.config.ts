import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker in the local runtime, with D1 and R2.
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Production-shaped placeholder values; tests that need others pass their own env.
              bindings: {
                APP_HOST: "artifacts.example.com",
                API_HOST: "artifacts-api.example.com",
                CONTENT_HOST_SUFFIX: "-art.example.com",
                PUBLIC_HOST_SUFFIX: "-pub.example.com",
                ARCHIVE_AFTER_DAYS: "30",
                ACCESS_TEAM_DOMAIN: "team.example.com",
                ACCESS_APP_AUD: "app-audience",
                ACCESS_CONTENT_AUD: "content-audience",
                API_TOKENS: "{}",
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["src/**/*.test.ts"],
          exclude: ["src/e2e.test.ts"],
          setupFiles: ["./src/test-setup.ts"],
          // Vitest empties CSS it does not process; the token tests read gallery.css and viewer.css as text.
          css: { include: [/(gallery|viewer)\.css/] },
        },
      },
      {
        // The Worker in wrangler's test harness, reached over HTTP from Node, as the CLI's end-to-end test reaches it.
        test: { name: "e2e", include: ["src/e2e.test.ts"], environment: "node" },
      },
      {
        // The build and deployment scripts, in Node as they run.
        test: { name: "scripts", include: ["scripts/**/*.test.ts"], environment: "node" },
      },
      {
        // The browser tests' own harness code, in Node without a browser; Playwright runs only `*.spec.ts`.
        test: { name: "browser-harness", include: ["browser/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
