/**
 * ISO-5: the gallery's markup comes from one tagged template, `html`, which escapes every value it interpolates. Only
 * markup that `html` itself built passes through unescaped, so artifact text (titles, descriptions, paths, content
 * types) can only ever be text or a quoted attribute value. Templates quote every attribute with `"`.
 */
import iconSvg from "./icon.svg";

import viewerCss from "./viewer.css";

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

/**
 * The viewer frame's inlined files (design.md section 6, "Assets"): files of the repository bundled with the Worker,
 * never a request's or an artifact's text, so they pass unescaped. They are built here so that no other module can turn
 * text into markup. The stylesheet is the content of a `<style>`, which entities would break; the icon is icon.svg as
 * inline SVG at 16 px without its comment, hidden from assistive technology since the link around it is named.
 */
export const VIEWER_STYLE = new Markup(viewerCss);
export const VIEWER_ICON = new Markup(
  iconSvg
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace("<svg ", '<svg class="viewer-header__icon" width="16" height="16" aria-hidden="true" ')
    .trim(),
);
