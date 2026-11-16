/**
 * Test support: the Worker as the CLI's end-to-end test of `login` runs it (design.md section 7, "Testing OAuth").
 * It is the deployed Worker except for Access's key set, which is the test's own public keys, given in the variable
 * `TEST_ACCESS_KEYS`, instead of the team domain's: the test signs the owner's Access JWT for the consent page. And
 * wrangler's test harness hands the Worker every request as `http`, even one sent to an `https` URL, so each request
 * gets back the `https` its hosts have when deployed; the OAuth library serves its metadata only on the issuer's
 * origin. Never deployed, since wrangler.jsonc's `main` is src/index.ts.
 */
import { AccessVerifier } from "./access.ts";
import { newArtifactId } from "./id.ts";
import { createWorker } from "./index.ts";
import { TIMEOUTS } from "./timeout.ts";

type TestEnv = Env & { readonly TEST_ACCESS_KEYS?: string };

/** The key set of the request being served; every request of a test run carries the same. */
let keys = "[]";

const worker = createWorker({
  now: () => Date.now(),
  newId: newArtifactId,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeouts: TIMEOUTS,
  access: new AccessVerifier({
    fetch: async () => new Response(`{"keys":${keys}}`, { headers: { "Content-Type": "application/json" } }),
    now: () => Date.now(),
  }),
});

export default {
  async fetch(request, env, ctx) {
    keys = env.TEST_ACCESS_KEYS ?? "[]";
    const url = new URL(request.url);
    url.protocol = "https:";
    return worker.fetch(new Request(url, request), env, ctx);
  },
} satisfies ExportedHandler<TestEnv>;
