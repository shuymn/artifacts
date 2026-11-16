import { defineConfig } from "vitest/config";

// The CLI runs on Bun, and `pnpm run test` runs the unit project under `bun --bun`. The e2e project runs on Node:
// wrangler's test harness does not forward requests under Bun (docs/decisions.md). The smoke project runs the binary
// that scripts/build.ts made, so the runtime running the tests does not matter.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["src/e2e.test.ts", "scripts/smoke.test.ts"],
        },
      },
      { test: { name: "e2e", include: ["src/e2e.test.ts"] } },
      // A first start of a 90 MB binary can be slow on a runner (Windows scans it).
      { test: { name: "smoke", include: ["scripts/smoke.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 } },
    ],
  },
});
