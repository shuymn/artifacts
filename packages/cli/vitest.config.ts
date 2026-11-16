import { defineConfig } from "vitest/config";

// The CLI runs on Bun, and `pnpm run test` runs the unit project under `bun --bun`. The e2e project runs on Node:
// wrangler's test harness does not forward requests under Bun (docs/decisions.md).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/e2e.test.ts"] } },
      { test: { name: "e2e", include: ["src/e2e.test.ts"] } },
    ],
  },
});
