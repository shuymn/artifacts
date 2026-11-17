/**
 * Test support: the Worker as e2e.test.ts runs it to read served bodies over real HTTP (design.md section 8, "Storage
 * failures"). A request that names a mode in `X-Test-Body` gets an R2 bucket whose `get` brings the stored bytes and,
 * a moment later: `stall`, nothing more and no end; `extra`, one byte past them; `fail`, an error. The R2 timeout is
 * short, so a stall ends quickly. Never deployed, since wrangler.jsonc's `main` is src/index.ts.
 */
import { AccessVerifier } from "./access.ts";
import { newArtifactId } from "./id.ts";
import { createWorker } from "./index.ts";

const MODES = ["stall", "extra", "fail"] as const;
type Mode = (typeof MODES)[number];

/** The R2 timeout of this Worker: long enough for a local read, short enough for a test to wait out a stall. */
const R2_MS = 300;

const worker = createWorker({
  now: () => Date.now(),
  newId: newArtifactId,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeouts: { r2Ms: R2_MS, d1ReadMs: 10_000, kvReadMs: 10_000 },
  access: new AccessVerifier({ fetch: (input, init) => fetch(input, init), now: () => Date.now() }),
});

/**
 * How long a broken body waits after the stored bytes before it breaks: the local runtime's entry worker answers 500 on
 * its own when a body errors before it has passed the response's headers on, which a deployed Worker never does.
 */
const LATER_MS = 100;

/** `stored`'s bytes, then what `mode` adds at their end. */
function broken(stored: ReadableStream<Uint8Array>, mode: Mode): ReadableStream<Uint8Array> {
  const reader = stored.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!done) {
        controller.enqueue(value);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, LATER_MS));
      if (mode === "extra") {
        controller.enqueue(new TextEncoder().encode("!"));
        controller.close();
      } else if (mode === "fail") controller.error(new Error("cut"));
      else await new Promise(() => {});
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** `bucket` with each `get` bringing a broken body; every other call goes to the bucket itself. */
function faulty(bucket: R2Bucket, mode: Mode): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "get") {
        return async (key: string) => {
          const object = await target.get(key);
          return object === null ? null : { body: broken(object.body, mode) };
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const mode = MODES.find((known) => known === request.headers.get("X-Test-Body"));
    return worker.fetch(request, mode === undefined ? env : { ...env, FILES: faulty(env.FILES, mode) }, ctx);
  },
} satisfies ExportedHandler<Env>;
