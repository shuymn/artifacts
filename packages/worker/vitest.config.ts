import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // Vitest empties CSS it does not process; the token test reads gallery.css as text.
  test: { css: { include: [/gallery\.css/] } },
});
