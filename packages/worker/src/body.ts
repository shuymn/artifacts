/**
 * RES-1: request bodies are counted while they are read, whether or not they declare a `Content-Length`. A body past
 * its bound stops being read and the request answers 413.
 */

/** A REST publish body: `formData()` holds it in memory, and an isolate has 128 MB and may serve several requests. */
export const PUBLISH_BODY_BYTES = 32 * 1024 * 1024;
/** A JSON body (`PATCH`): the largest valid one is under 100 bytes. */
export const JSON_BODY_BYTES = 4 * 1024;

export type BodyRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "too_large" | "malformed" };

class BodyTooLarge extends Error {}

/** The request body cut off at `limit` bytes, or undefined when its declared length is already over. */
function counted(request: Request, limit: number): { body: ReadableStream | null; over: () => boolean } | undefined {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) return undefined;
  let total = 0;
  let over = false;
  const body =
    request.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > limit) {
            over = true;
            controller.error(new BodyTooLarge());
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    ) ?? null;
  return { body, over: () => over };
}

/** The bytes of `request`'s body, read through the count, for a parser that reads them later (the OAuth library). */
export async function readBytes(request: Request, limit: number): Promise<BodyRead<Uint8Array>> {
  const body = counted(request, limit);
  if (body === undefined) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: new Uint8Array(await new Response(body.body).arrayBuffer()) };
  } catch {
    return { ok: false, reason: body.over() ? "too_large" : "malformed" };
  }
}

/** The multipart body of `request`, read through the count. */
export async function readFormData(request: Request, limit: number): Promise<BodyRead<FormData>> {
  const body = counted(request, limit);
  if (body === undefined) return { ok: false, reason: "too_large" };
  const contentType = request.headers.get("Content-Type") ?? "";
  try {
    return { ok: true, value: await new Response(body.body, { headers: { "Content-Type": contentType } }).formData() };
  } catch {
    return { ok: false, reason: body.over() ? "too_large" : "malformed" };
  }
}

/** The JSON body of `request`, read through the count. */
export async function readJson(request: Request, limit: number): Promise<BodyRead<unknown>> {
  const body = counted(request, limit);
  if (body === undefined) return { ok: false, reason: "too_large" };
  let text: string;
  try {
    text = await new Response(body.body).text();
  } catch {
    return { ok: false, reason: body.over() ? "too_large" : "malformed" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
