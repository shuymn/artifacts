import { sha256Hex } from "../objects.ts";
/**
 * The files every gallery page loads (docs/gallery/design.md, "Ground rules" and "Icon"): `gallery.css` as it is in the
 * repository, the `@font-face` stylesheet, the fonts it names, and the icon as SVG and as ICO. They are bundled with
 * the Worker (wrangler.jsonc's module rules), so serving them reads no storage.
 *
 * Every one but `/favicon.ico` is served at a fingerprinted path, its name with a hash of its bytes
 * (`/assets/gallery.<hash>.css`), computed when the module loads; design.md section 6 caches those as immutable.
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
 * Artifact hosts answer the same path with it when the artifact has no file of its own (design.md section 6). Its URL
 * is fixed, so it revalidates instead of being fingerprinted.
 */
export const FAVICON: Asset = { contentType: "image/vnd.microsoft.icon", body: favicon };

/** A file's name under `/assets/`, as pages and fonts.css name it: `gallery.css`, `fonts/<file>.woff2`. */
export type AssetName = string;

/** The bundled files to fingerprint. fonts.css names each font by its name relative to itself (`fonts/<file>`). */
export type AssetSources = {
  readonly galleryCss: string;
  readonly fontsCss: string;
  readonly iconSvg: string;
  readonly fonts: ReadonlyMap<AssetName, ArrayBuffer>;
};

/** The fingerprinted files: each one's path by its name, each one by its path, and each one by its name. */
export type FingerprintedAssets = {
  readonly paths: ReadonlyMap<AssetName, string>;
  readonly files: ReadonlyMap<string, Asset>;
  readonly named: ReadonlyMap<AssetName, Asset>;
};

/**
 * 64 bits of the SHA-256 of the bytes: a new deployment's changed file gets a new path. It runs at module load, in the
 * Workers runtime's global scope, which refuses stream I/O, so it digests with `crypto.subtle.digest` rather than
 * `sha256Hex`'s DigestStream. The test runtime does not enforce that; `wrangler dev` does.
 */
async function fingerprint(body: string | ArrayBuffer): Promise<string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes), 0, 8);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `fonts/x.woff2` → `/assets/fonts/x.<hash>.woff2`. */
function pathOf(name: AssetName, hash: string): string {
  const dot = name.lastIndexOf(".");
  return `/assets/${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
}

/** fonts.css's `url("fonts/<file>")`. */
const FONT_URL = /url\("(fonts\/[^"]+)"\)/g;

/**
 * Fingerprints every file. Fonts come first: fonts.css is rewritten to name their fingerprinted paths, so a changed
 * font changes fonts.css's path too. A font fonts.css names that is not bundled is a build error.
 */
export async function fingerprintAssets(sources: AssetSources): Promise<FingerprintedAssets> {
  const paths = new Map<AssetName, string>();
  const files = new Map<string, Asset>();
  const named = new Map<AssetName, Asset>();
  const add = async (name: AssetName, asset: Asset) => {
    const path = pathOf(name, await fingerprint(asset.body));
    paths.set(name, path);
    files.set(path, asset);
    named.set(name, asset);
  };
  for (const [name, body] of sources.fonts) await add(name, { contentType: WOFF2, body });
  const fonts = sources.fontsCss.replace(FONT_URL, (_, name: string) => {
    const path = paths.get(name);
    if (path === undefined) throw new Error(`fonts.css names ${name}, which is not bundled`);
    return `url("${path}")`;
  });
  await add("fonts.css", { contentType: CSS, body: fonts });
  await add("gallery.css", { contentType: CSS, body: sources.galleryCss });
  await add("icon.svg", { contentType: "image/svg+xml", body: sources.iconSvg });
  return { paths, files, named };
}

/** `/assets/<name>.<hash>.<ext>` or `/assets/<name>.<ext>`: the name and the extension. */
const ASSET_PATH = /^\/assets\/(.+?)(?:\.[0-9a-f]{16})?(\.[a-z0-9]+)$/;

/**
 * The asset a path names, and whether the path is its current one. A path whose name and extension are a current
 * asset's but whose fingerprint is another (a page from an earlier deployment) or missing (a release before
 * fingerprints) names the current file too: design.md section 6 serves it revalidated, never as immutable.
 */
export function findAsset(
  assets: FingerprintedAssets,
  path: string,
): { readonly asset: Asset; readonly current: boolean } | undefined {
  const exact = assets.files.get(path);
  if (exact !== undefined) return { asset: exact, current: true };
  const match = ASSET_PATH.exec(path);
  const asset = match === null ? undefined : assets.named.get(`${match[1]}${match[2]}`);
  return asset === undefined ? undefined : { asset, current: false };
}

export const GALLERY_ASSETS = await fingerprintAssets({
  galleryCss,
  fontsCss,
  iconSvg,
  fonts: new Map([
    ["fonts/ibm-plex-sans-latin-400-normal.woff2", sansRegular],
    ["fonts/ibm-plex-sans-latin-500-normal.woff2", sansMedium],
    ["fonts/ibm-plex-sans-latin-600-normal.woff2", sansSemibold],
    ["fonts/ibm-plex-mono-latin-400-normal.woff2", monoRegular],
    ["fonts/ibm-plex-mono-latin-500-normal.woff2", monoMedium],
    ["fonts/ibm-plex-mono-latin-600-normal.woff2", monoSemibold],
  ]),
});

/** The fingerprinted path of a bundled file, by its name. */
export function assetPath(name: AssetName): string {
  const path = GALLERY_ASSETS.paths.get(name);
  if (path === undefined) throw new Error(`no gallery asset named ${name}`);
  return path;
}

/** A strong entity tag of an asset: 128 bits of the SHA-256 of its bytes, which only a deployment changes. */
export async function assetTag(asset: Asset): Promise<string> {
  return `"${(await sha256Hex(new Blob([asset.body]))).slice(0, 32)}"`;
}
