// The design file and gallery.css carry tokens.json one to one (docs/gallery/design.md, "Tokens"). In gallery.css every
// token is a custom property with the value the mapping gives, and every typography token is one rule headed by its
// name; in gallery.pen every other token is a Pencil variable, and every typography token a reusable text.
import { describe, expect, it } from "vitest";

import pen from "../../../../docs/gallery/gallery.pen?raw";
import tokens from "../../../../docs/gallery/tokens.json";

import css from "./gallery.css?raw";

type Token = { $type: string; $value: unknown };
type Typography = { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isToken = (value: Record<string, unknown>): value is Token =>
  typeof value.$type === "string" && "$value" in value;
const isTypography = (value: unknown): value is Typography =>
  isRecord(value) &&
  typeof value.fontFamily === "string" &&
  typeof value.fontSize === "string" &&
  typeof value.fontWeight === "string" &&
  typeof value.lineHeight === "number";

function flatten(node: Record<string, unknown>, prefix: string[] = []): Map<string, Token> {
  const out = new Map<string, Token>();
  for (const [key, value] of Object.entries(node)) {
    if (!isRecord(value)) continue;
    const path = [...prefix, key];
    if (isToken(value)) out.set(path.join("."), value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const all = flatten(tokens);
const varName = (name: string) => `--${name.replaceAll(".", "-")}`;
const ref = (value: string) => value.replace(/^\{(.+)\}$/, (_, name: string) => `var(${varName(name)})`);
const rem = (px: string) => `${Number(px.replace(/px$/, "")) / 16}rem`;
const FALLBACK: Record<string, string> = { sans: "system-ui, sans-serif", mono: "ui-monospace, monospace" };

function expected(name: string, token: Token): string | undefined {
  const value = token.$value;
  if (name.startsWith("type.") || name === "size.page") return undefined;
  if (typeof value === "string" && value.startsWith("{")) return ref(value);
  if (token.$type === "color") return String(value).toLowerCase();
  if (token.$type === "fontWeight") return String(value);
  if (token.$type === "fontFamily") return `"${String(value)}", ${FALLBACK[name.split(".").at(-1) ?? ""]}`;
  if (/^(space|font\.size|size)\./.test(name)) return rem(String(value));
  return String(value);
}

function rootProperties(): Map<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  return new Map([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

describe("gallery.css and tokens.json", () => {
  it("declares exactly the tokens as custom properties, with the mapped values", () => {
    const want = new Map<string, string>();
    for (const [name, token] of all) {
      const value = expected(name, token);
      if (value !== undefined) want.set(varName(name), value);
    }
    expect(Object.fromEntries(rootProperties())).toEqual(Object.fromEntries(want));
  });

  it("has one rule per typography token, with its font shorthand", () => {
    const want: Record<string, string[]> = {};
    const got: Record<string, (string | undefined)[]> = {};
    for (const [name, token] of all) {
      if (!name.startsWith("type.")) continue;
      const v = token.$value;
      if (!isTypography(v)) throw new Error(`${name} is not a typography value`);
      want[name] = [`${ref(v.fontWeight)} ${ref(v.fontSize)} / ${v.lineHeight} ${ref(v.fontFamily)}`];
      const rule = new RegExp(`/\\* ${name.replace(".", "\\.")} \\*/\\n[^{]+\\{\\s*font: ([^;]+);`, "g");
      got[name] = [...css.matchAll(rule)].map((m) => m[1]);
    }
    expect(got).toEqual(want);
  });

  it("declares custom properties only in the token block", () => {
    const declared = [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
    expect(declared).toEqual([...rootProperties().keys()]);
  });

  it("sets fonts only through the typography rules", () => {
    const tagged = [...css.matchAll(/\/\* type\.[\w-]+ \*\/\n[^{]+\{\s*font: [^;]+;/g)].length;
    expect([...css.matchAll(/(?<![\w-])font\s*:/g)]).toHaveLength(tagged);
    expect(css.match(/(?<![\w-])(font-(family|size|weight|style)|line-height)\s*:/g)).toBeNull();
  });

  it("uses no typography token that is not in tokens.json", () => {
    const named = [...css.matchAll(/\/\* (type\.[\w-]+) \*\//g)].map((m) => m[1]);
    expect(named.filter((n) => n === undefined || !all.has(n))).toEqual([]);
  });
});

const design: unknown = JSON.parse(pen);
const penRef = (value: string) => value.replace(/^\{(.+)\}$/, (_, name: string) => `$${name}`);
const PEN_TYPE: Record<string, string> = {
  color: "color",
  dimension: "number",
  fontFamily: "string",
  fontWeight: "string",
};

// Pencil keeps a color's hex as written; it is compared in lower case.
const penValue = (type: unknown, value: unknown) =>
  type === "color" && typeof value === "string" && value.startsWith("#") ? value.toLowerCase() : value;

function penVariable(token: Token): { type: string | undefined; value: unknown } {
  const value = token.$value;
  const type = PEN_TYPE[token.$type];
  if (typeof value === "string" && value.startsWith("{")) return { type, value: penRef(value) };
  if (token.$type === "dimension") return { type, value: Number(String(value).replace(/px$/, "")) };
  return { type, value: penValue(type, String(value)) };
}

function* penNodes(node: unknown): Generator<Record<string, unknown>> {
  if (!isRecord(node)) return;
  yield node;
  if (Array.isArray(node.children)) for (const child of node.children) yield* penNodes(child);
}

describe("gallery.pen and tokens.json", () => {
  it("defines exactly the tokens as variables, with the mapped values", () => {
    const want: Record<string, unknown> = {};
    for (const [name, token] of all) if (!name.startsWith("type.")) want[name] = penVariable(token);
    const variables = isRecord(design) && isRecord(design.variables) ? design.variables : {};
    const got: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(variables))
      got[name] = isRecord(v) ? { type: v.type, value: penValue(v.type, v.value) } : v;
    expect(got).toEqual(want);
  });

  it("has one reusable text per typography token, with its font", () => {
    const want: Record<string, unknown[]> = {};
    for (const [name, token] of all) {
      if (!name.startsWith("type.")) continue;
      const v = token.$value;
      if (!isTypography(v)) throw new Error(`${name} is not a typography value`);
      const [fontFamily, fontSize, fontWeight] = [v.fontFamily, v.fontSize, v.fontWeight].map(penRef);
      want[name] = [{ fontFamily, fontSize, fontWeight, lineHeight: v.lineHeight }];
    }
    const got: Record<string, unknown[]> = {};
    for (const n of penNodes(design)) {
      if (n.reusable !== true || n.type !== "text" || typeof n.name !== "string" || !n.name.startsWith("type."))
        continue;
      const { fontFamily, fontSize, fontWeight, lineHeight } = n;
      (got[n.name] ??= []).push({ fontFamily, fontSize, fontWeight, lineHeight });
    }
    expect(got).toEqual(want);
  });
});
