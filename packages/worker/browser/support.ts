/** What the browser tests share: the Worker's hosts, its API token, and publishing through its REST API. */
import { request } from "node:http";

/** The variable server.ts passes the harness's port in. */
export const PORT_VARIABLE = "ARTIFACTS_BROWSER_PORT";

/** The API token the Worker accepts, for publishing; local to the test run. */
export const TOKEN = `art_${"b".repeat(32)}`;

function port(): string {
  const value = process.env[PORT_VARIABLE];
  if (value === undefined) throw new Error(`${PORT_VARIABLE} is not set: run the tests through playwright.config.ts`);
  return value;
}

export const appOrigin = () => `http://app.localhost:${port()}`;
export const contentOrigin = (id: string) => `http://${id}-art.localhost:${port()}`;
export const publicOrigin = (id: string) => `http://${id}-pub.localhost:${port()}`;

type Answer = { readonly status: number; readonly body: string };

/** One request to the harness with `host` in its `Host` header: Node's `fetch` sends the URL's host instead. */
function send(method: string, host: string, path: string, headers: Record<string, string>, body?: Uint8Array) {
  return new Promise<Answer>((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port: port(), method, path, headers: { ...headers, Host: host } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function api(method: string, path: string, form: FormData): Promise<Answer> {
  // Node encodes the multipart body and its boundary; the request carries them as bytes and headers.
  const encoded = new Request(`http://api.localhost${path}`, { method, body: form });
  const headers = Object.fromEntries([...encoded.headers, ["Authorization", `Bearer ${TOKEN}`]]);
  return send(method, `api.localhost:${port()}`, path, headers, new Uint8Array(await encoded.arrayBuffer()));
}

function publishForm(title: string, files: Readonly<Record<string, string>>, base?: number): FormData {
  const form = new FormData();
  const meta = {
    title,
    files: Object.keys(files).map((path) => ({ path })),
    ...(base === undefined ? {} : { base_version: base }),
  };
  form.append("meta", JSON.stringify(meta));
  for (const body of Object.values(files)) form.append("file", new Blob([body]), "file.bin");
  return form;
}

/** Creates an artifact and returns its ID. */
export async function create(title: string, files: Readonly<Record<string, string>>): Promise<string> {
  const answer = await api("POST", "/v1/artifacts", publishForm(title, files));
  if (answer.status !== 201) throw new Error(`create answered ${answer.status}: ${answer.body}`);
  const id: unknown = JSON.parse(answer.body).artifact?.id;
  if (typeof id !== "string") throw new Error("the create answer names no artifact");
  return id;
}

/** Publishes version `base + 1` of an artifact. */
export async function update(id: string, base: number, files: Readonly<Record<string, string>>): Promise<void> {
  const answer = await api("POST", `/v1/artifacts/${id}/versions`, publishForm(`v${base + 1}`, files, base));
  if (answer.status !== 201) throw new Error(`update answered ${answer.status}: ${answer.body}`);
}

/**
 * A browser without `popover`, as Safari 16.4 to 16.6 are (design.md, PL-55): the property leaves
 * `HTMLElement.prototype`, and the `popover` and `popovertarget` attributes leave each element as the parser inserts
 * it, before the frame's script runs, so neither the browser's hiding nor its toggling applies.
 */
export function withoutPopover(): void {
  // The page runs this function's text alone, so it refers to nothing outside it.
  Reflect.deleteProperty(HTMLElement.prototype, "popover");
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const element of [node, ...node.querySelectorAll("[popover], [popovertarget]")]) {
          element.removeAttribute("popover");
          element.removeAttribute("popovertarget");
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
}
