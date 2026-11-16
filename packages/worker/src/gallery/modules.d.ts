// Wrangler's module rules (wrangler.jsonc): the gallery's stylesheets and SVG icon are bundled as text, its fonts and
// ICO icon as bytes.
declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*.svg" {
  const text: string;
  export default text;
}

declare module "*.woff2" {
  const bytes: ArrayBuffer;
  export default bytes;
}

declare module "*.ico" {
  const bytes: ArrayBuffer;
  export default bytes;
}
