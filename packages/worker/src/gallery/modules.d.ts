// Wrangler's module rules (wrangler.jsonc): the gallery's stylesheets are bundled as text, its fonts as bytes.
declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*.woff2" {
  const bytes: ArrayBuffer;
  export default bytes;
}
