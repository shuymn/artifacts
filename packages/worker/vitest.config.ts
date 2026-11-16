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
          setupFiles: ["./src/test-setup.ts"],
          // Vitest empties CSS it does not process; the token test reads gallery.css as text.
          css: { include: [/gallery\.css/] },
        },
      },
      {
        // The deployment script, in Node as it runs.
        test: { name: "deploy", include: ["scripts/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
