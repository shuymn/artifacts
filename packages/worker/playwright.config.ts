// The browser tests (design.md, plan layer PL-55 and PL-58): the Worker in wrangler's test harness, on a localhost
// configuration, driven in Chromium, Firefox and WebKit. browser/server.ts starts it once for the run.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "*.spec.ts",
  globalSetup: "./browser/server.ts",
  // Every test publishes its own artifact, so tests share the one Worker without depending on each other.
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
