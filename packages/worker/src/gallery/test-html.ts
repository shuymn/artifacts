/**
 * Helpers for the gallery's tests: an HTML document as a tree, parsed by the runtime's HTMLRewriter (a real HTML
 * tokenizer). Elements keep their attributes as written; text is kept in `#text` nodes, entities decoded.
 */

export type HtmlNode = {
  /** The tag name, lowercase; `#text` for text. */
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
  /** A text node's text. */
  readonly text: string;
};

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** Decodes the entities the gallery writes; the reference pages write none. */
export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "");
}

/** HTML's void elements, which have no end tag (the runtime's `canHaveContent` is not available). */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export async function parseHtml(source: string): Promise<HtmlNode> {
  const root: HtmlNode = { tag: "#document", attributes: new Map(), children: [], text: "" };
  const stack: HtmlNode[] = [root];
  const top = () => stack.at(-1) ?? root;
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: HtmlNode = {
          tag: element.tagName,
          attributes: new Map(Array.from(element.attributes, ([name = "", value = ""]) => [name, value] as const)),
          children: [],
          text: "",
        };
        top().children.push(node);
        if (VOID.has(element.tagName)) return;
        stack.push(node);
        element.onEndTag(() => {
          stack.pop();
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (chunk.text !== "")
          top().children.push({ tag: "#text", attributes: new Map(), children: [], text: chunk.text });
      },
    })
    .transform(new Response(source))
    .text();
  return root;
}

/** Every element below `node`, in document order. */
export function elements(node: HtmlNode): HtmlNode[] {
  return node.children.filter((child) => child.tag !== "#text").flatMap((child) => [child, ...elements(child)]);
}

/** The elements below `node` whose class list has `name`. */
export function byClass(node: HtmlNode, name: string): HtmlNode[] {
  return elements(node).filter((element) => (element.attributes.get("class") ?? "").split(/\s+/).includes(name));
}

/** The text below `node` in document order, entities decoded and whitespace collapsed as rendering collapses it. */
export function textOf(node: HtmlNode): string {
  const all = (n: HtmlNode): string => (n.tag === "#text" ? n.text : n.children.map(all).join(""));
  return decodeEntities(all(node)).replace(/\s+/g, " ").trim();
}
