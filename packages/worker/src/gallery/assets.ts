import { sha256Hex } from "../objects.ts";
/**
 * The files every gallery page loads (docs/gallery/design.md, "Ground rules" and "Icon"): `gallery.css` as it is in the
 * repository, the `@font-face` stylesheet, the fonts it names, and the icon as SVG and as ICO. They are bundled with
 * the Worker (wrangler.jsonc's module rules), so serving them reads no storage.
 */
import favicon from "./favicon.ico";
import monoRegular from "./fonts/ibm-plex-mono-latin-400-normal.woff2";
import monoMedium from "./fonts/ibm-plex-mono-latin-500-normal.woff2";
import monoSemibold from "./fonts/ibm-plex-mono-latin-600-normal.woff2";
import sansRegular from "./fonts/ibm-plex-sans-latin-400-normal.woff2";
import sansMedium from "./fonts/ibm-plex-sans-latin-500-normal.woff2";
import sansSemibold from "./fonts/ibm-plex-sans-latin-600-normal.woff2";
import iconSvg from "./icon.svg";

import fontsCss from "./fonts.css";
import galleryCss from "./gallery.css";

export type Asset = { readonly contentType: string; readonly body: string | ArrayBuffer };

const CSS = "text/css; charset=utf-8";
const WOFF2 = "font/woff2";

/**
 * The icon at `/favicon.ico`, which browsers request on their own: an ICO file, which every browser reads there.
 */
export const FAVICON: Asset = { contentType: "image/vnd.microsoft.icon", body: favicon };

/** Each asset by its path on the app host; fonts.css names the fonts relative to itself. */
export const ASSETS: ReadonlyMap<string, Asset> = new Map([
  ["/favicon.ico", FAVICON],
  ["/assets/icon.svg", { contentType: "image/svg+xml", body: iconSvg }],
  ["/assets/gallery.css", { contentType: CSS, body: galleryCss }],
  ["/assets/fonts.css", { contentType: CSS, body: fontsCss }],
  ["/assets/fonts/ibm-plex-sans-latin-400-normal.woff2", { contentType: WOFF2, body: sansRegular }],
  ["/assets/fonts/ibm-plex-sans-latin-500-normal.woff2", { contentType: WOFF2, body: sansMedium }],
  ["/assets/fonts/ibm-plex-sans-latin-600-normal.woff2", { contentType: WOFF2, body: sansSemibold }],
  ["/assets/fonts/ibm-plex-mono-latin-400-normal.woff2", { contentType: WOFF2, body: monoRegular }],
  ["/assets/fonts/ibm-plex-mono-latin-500-normal.woff2", { contentType: WOFF2, body: monoMedium }],
  ["/assets/fonts/ibm-plex-mono-latin-600-normal.woff2", { contentType: WOFF2, body: monoSemibold }],
]);

/** A strong entity tag of an asset: 128 bits of the SHA-256 of its bytes, which only a deployment changes. */
export async function assetTag(asset: Asset): Promise<string> {
  return `"${(await sha256Hex(new Blob([asset.body]))).slice(0, 32)}"`;
}
