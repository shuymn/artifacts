/**
 * ISO-5: the gallery's markup comes from one tagged template, `html`, which escapes every value it interpolates. Only
 * markup that `html` itself built passes through unescaped, so artifact text (titles, descriptions, paths, content
 * types) can only ever be text or a quoted attribute value. Templates quote every attribute with `"`.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Markup built by `html`; not exported, so nothing else can make a value that skips escaping. */
class Markup {
  constructor(readonly text: string) {}
}

export type { Markup };

/** What a template interpolates: markup, text, a number, a list of them, or nothing (`null`, `undefined`, `false`). */
export type Value = Markup | string | number | readonly Value[] | null | undefined | false;

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number") return escapeHtml(String(value));
  if (value instanceof Markup) return value.text;
  return value.map(render).join("");
}

export function html(strings: TemplateStringsArray, ...values: readonly Value[]): Markup {
  let text = strings[0] ?? "";
  values.forEach((value, index) => {
    text += render(value) + (strings[index + 1] ?? "");
  });
  return new Markup(text);
}
