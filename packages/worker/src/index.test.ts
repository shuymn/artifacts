import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

// The deployed entry point with the test configuration (vitest.config.ts): it classifies by host before anything else.
it("answers an unknown host 404 and the API without a token 401", async () => {
  const unknown = await exports.default.fetch("https://example.com/");
  expect(unknown.status).toBe(404);
  const api = await exports.default.fetch("https://artifacts-api.example.com/v1/artifacts");
  expect(api.status).toBe(401);
  expect(api.headers.get("WWW-Authenticate")).toBe("Bearer");
});
