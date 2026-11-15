import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("answers every request 404 Not Found", async () => {
  for (const url of ["https://example.com/", "https://example.com/api/artifacts", "https://example.com/mcp"]) {
    const response = await SELF.fetch(url);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  }
});
