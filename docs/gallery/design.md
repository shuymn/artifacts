# Gallery design system

The gallery's screens are designed in Pencil from tokens and components, and the code uses the same tokens and
components by name. The design file is [`gallery.pen`](gallery.pen): the boards Typography and Components above one
screen per page (`index`, `archived`, `artifact`), at the width `size.page` gives. Three files carry the design into
the code, and the implementation follows them exactly:

- [`tokens.json`](tokens.json): the token set, the one source of the tokens' names and values.
- [`gallery.css`](../../packages/worker/src/gallery/gallery.css): the stylesheet the Worker serves. Every token is a
  custom property, every component a class.
- [`reference/`](reference/): one static page per screen (`index.html`, `archived.html`, `artifact.html`) with the
  markup the Worker's templates must produce. They load `gallery.css` and render like the Pencil screens.

A design change goes to all of them: the Pencil file first, then `tokens.json`, `gallery.css` and the reference pages,
then the templates. Content and behavior of each page are in [design.md](../design.md), section 10.

`gallery.pen` is JSON, and the committed file has no `fileToken`. Pencil adds that member each time it saves the file;
it is not part of the design, and the secret scan reports it. Before the scan, the pre-commit hook cuts it out of the
staged copy of each `.pen` file with [`strip-pen-file-token.mjs`](../../scripts/strip-pen-file-token.mjs) and leaves
the working file alone, so a partly staged file keeps its unstaged part. The working file keeps the member, so after a
save git shows the file changed by that one line; Pencil opens the file with or without it.

## Ground rules

- **Dark only.** The owner uses a dark color scheme, so the gallery has one theme (`color-scheme: dark`). A light theme
  would be a second token set with the same names.
- **No script, forms or frames** (design.md, section 10). Every state is a link or plain markup.
- **Text scales with the user's setting.** Each page has `<meta name="text-scale" content="scale">`, no rule sets a
  root `font-size`, and text and the spacing around it are in `rem`.
- **Fonts are served by the Worker**: IBM Plex Sans and IBM Plex Mono (Latin subsets, `woff2`) in a separate
  `@font-face` stylesheet, all at fingerprinted paths cached as immutable ([design.md](../design.md), section 6). A page
  that loads its stylesheets or fonts after the next deployment gets that deployment's files at its own outdated paths,
  revalidated rather than immutable, so it renders with the current stylesheet and fonts instead of unstyled.
  `gallery.css` falls back to `system-ui` and `ui-monospace` with `font-size-adjust: from-font`, so Japanese text falls
  back to the system font at the same x-height. The reference pages load the same fonts from Google Fonts instead, for
  previewing only.
- **Text never changes font after it shows.** Every face has `font-display: optional`, and every page preloads the faces
  the top of its pages uses: Sans 400 (body), Sans 600 (headings, titles) and Mono 400 (counts, meta) at a font's
  default priority, Sans 500 (links, badges) and Mono 600 (the wordmark) with `fetchpriority="low"`; Mono 500 is
  declared but no rule uses it. A preloaded optional face holds rendering for up to about 100 ms until it loads, and a
  face that misses that window is not swapped in later ([web.dev, "Prevent layout shifting and flashes of invisible text
  by preloading optional fonts"](https://web.dev/articles/preload-optional-fonts)). With the files cached, only a page
  that finds a face uncached (after its bytes change, or in a fresh browser) can miss it, and it then shows the fallback
  until the next page. `swap` would paint the fallback first and swap each face in as it arrives, a flash whenever the
  fonts are not already loaded. The `@font-face` rules stay in their own stylesheet rather than in `gallery.css` or
  inline: the preloads let the browser fetch the fonts from the HTML, so the stylesheet no longer sits before them;
  `gallery.css` stays the file the reference pages load; and an inline `<style>` would need its hash in the CSP's
  `style-src` and would travel with every page instead of being cached once.

## Icon

The gallery has one icon: the `a` of the monospace wordmark in `color.accent`, on a tile of `color.bg` with
`radius.sm`. It is drawn by hand; its source is [`icon.svg`](../../packages/worker/src/gallery/icon.svg), on a
32-unit grid with every edge on an even coordinate so it stays sharp at 16 px. The `site-header` component in
`gallery.pen` repeats its shapes at 16 px.

- **Light and dark chrome.** The icon looks the same in both: the tile carries the gallery's own background, so the
  glyph keeps its contrast whatever the tab strip's color, and the ICO, which cannot switch, matches the SVG. A
  `prefers-color-scheme` variant would need a light palette the dark-only gallery does not have.
- **Files.** Pages link `icon.svg` at its fingerprinted path (`/assets/icon.<hash>.svg`, `type="image/svg+xml"`) and
  `/favicon.ico` (`sizes="32x32"`, which keeps Chrome from choosing the ICO over the SVG).
  [`favicon.ico`](../../packages/worker/src/gallery/favicon.ico) is `icon.svg` rendered at 16 and 32 px and stored as
  PNG images; after a change to the SVG, `uv run packages/worker/scripts/favicon.py` writes it again. Artifact hosts
  answer `/favicon.ico` with the same file when the artifact has none ([design.md](../design.md), section 6).
- **In the header.** The icon comes before the wordmark, inside the brand's link, as an `img` of `icon.svg` at its
  fingerprinted path. It is the wordmark's font size, `1em`, which is 16 px at the default text size, where the grid
  falls on whole pixels; `width` and `height` of 16 hold its place until it loads, and its `alt` is empty because the
  link's text names it. The tile is the header's own color, so only the glyph shows, `space.1` before the wordmark.
  Centered on the wordmark's line, the glyph's foot would sit 1 px above its baseline; `space.0-5` above the icon
  lowers it by half that, onto the baseline.

## Tokens

`tokens.json` has the Design Tokens format's shape: `$type` and `$value` per token, dimensions as strings with `px`,
typography without letter spacing. It is not checked against the DTCG schema.

`tokens.json` stays a file of its own, the one source of the tokens, and `gallery.pen` and `gallery.css` mirror it:
[`tokens.test.ts`](../../packages/worker/src/gallery/tokens.test.ts) checks both against it, so a change to one of
the three fails the tests until the others follow. `gallery.pen` is not the source because Pencil's variables
hold only colors, numbers, strings and booleans: the typography tokens exist in it only as texts, and the file is
Pencil's document, whose node ids and layout change with every edit, rather than a token set.

| Token                                       | In `gallery.css`                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every token except `type.*` and `size.page` | the custom property `--a-b-c` for `a.b.c` on `:root` (`space.0-5` → `--space-0-5`)                                                                                                                            |
| `color.*`                                   | the hex value; a reference (`{color.accent}`) becomes `var(--color-accent)`                                                                                                                                   |
| `space.*`, `font.size.*`, `size.*`          | `px ÷ 16` in `rem` (`space.4`: 16px → `1rem`)                                                                                                                                                                 |
| `radius.*`, `border.width`, `focus.width`   | `px`                                                                                                                                                                                                          |
| `font.family.sans` / `font.family.mono`     | the family, then `system-ui, sans-serif` / `ui-monospace, monospace`                                                                                                                                          |
| `font.weight.*`                             | the number                                                                                                                                                                                                    |
| `type.x` (typography)                       | one rule, headed by the comment `/* type.x */`, whose `font` shorthand is `var(--font-weight-…) var(--font-size-…) / <line height> var(--font-family-…)`; the selectors listed are every element that uses it |
| `size.page`                                 | none: it is the width of the Pencil screens, not of the page                                                                                                                                                  |

| Token                                                                         | In `gallery.pen`                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every token except `type.*`                                                   | the variable of the same name (`space.0-5`), which the components and screens bind                                                                                                                                                                      |
| `color.*`                                                                     | a color variable with the hex value; a reference (`{color.accent}`) becomes `$color.accent`                                                                                                                                                             |
| `space.*`, `radius.*`, `border.width`, `focus.width`, `font.size.*`, `size.*` | a number variable, in pixels                                                                                                                                                                                                                            |
| `font.family.*`                                                               | a string variable                                                                                                                                                                                                                                       |
| `font.weight.*`                                                               | a string variable (`"400"`), the only type Pencil binds to a font weight                                                                                                                                                                                |
| `type.x` (typography)                                                         | the reusable text `type.x` on the Typography board, with the family, size and weight bound to their variables and the line height as a number. Pencil has no text styles: every text in the components and screens is an instance of one of these texts |

The `.pen` format allows a variable for a width, but Pencil (1.2.23) drops it: a width set to `$size.content` reads
back as `fit_content(0)`, and a file that has one is saved with `fit_content(0)`. So the frames repeat `size.*` as
numbers, and `tokens.test.ts` checks that each has its token's value: `size.page` on the screens and the `site-header`
component, `size.content` on `page` and the `pager` and `artifact-row` components, `size.prose` on the artifact
description, `size.label` on the term of `info-row`.

Values Pencil shows that are not tokens (a text's measured width or height, a frame's height, the width of a table
column) are not part of the design.

## Components

Each component in `gallery.pen` is one class in `gallery.css`; a variant is a modifier class or an attribute. Pencil has
no variants, so each variant is a component of its own, named `component/variant` (`nav-tab/state=current`). The
reference pages show each in place.

| Component         | Variant                                         | Markup                                                                                                          |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `site-header`     |                                                 | `header.site-header` > `div.brand` + `nav.site-nav`                                                             |
| `nav-tab`         | `state=default`                                 | `a.nav-tab` > text + `span.nav-tab__count`                                                                      |
|                   | `state=current`                                 | the same with `aria-current`: `"page"` on the list it links to, `"true"` on an artifact page in that section    |
| `artifact-row`    |                                                 | `li.artifact-row` in `ul.artifact-list[role=list]`; see `reference/index.html`                                  |
| `badge`           | `kind=public` / `kind=archived` / `kind=latest` | `span.badge.badge--public` / `.badge--archived` / `.badge--latest`                                              |
| `pager`           |                                                 | `nav.pager` with an `aria-label` > one `a`                                                                      |
| `back-link`       |                                                 | `a.back-link`                                                                                                   |
| `section-heading` |                                                 | `h2.section-heading` with an `id` > text + `span.section-heading__count`                                        |
| `info-row`        | `value=text`                                    | `div.info-row` > `dt` + `dd`, in `dl.info`                                                                      |
|                   | `value=link`                                    | the same with `dd.info-row__link` > `a`                                                                         |
| `table-cell`      | `style=head`                                    | `thead th[scope=col]`                                                                                           |
|                   | `style=text` / `mono` / `muted` / `link`        | `td` / `td.cell--mono` / `td.cell--muted` / `td.cell--link` > `a`; every `td` has `data-label`, its column name |

In `site-header`, `div.brand` is `a.brand__link` (`img.brand__icon` and the wordmark) then `span.brand__version`.

Screens also use `main.page` (`.page--detail` on an artifact page), `hgroup.page-heading`, `header.artifact-heading`,
`section.section` and `div.data-table[role=region][tabindex=0][aria-labelledby]` around each `table`; `.cell--grow`
marks the column that takes the remaining width (the version title, the file path).

Lists and tables carry their roles explicitly (`role=list`; `table`, `rowgroup`, `row`, `columnheader`, `cell`):
Safari drops list semantics without list markers, and browsers may drop table semantics when the narrow layout
changes a table's `display`.

Pencil draws the design's strokes inside the frame (`strokeAlignment: inner`) and lays out the children by the padding
alone, so a stroke covers the outer pixel of the padding. CSS draws a border outside the padding, so content inside a
bordered container sits one pixel further in. The nav tab subtracts its border from its padding, because its size is
part of the design; the other containers keep the one pixel. Pencil paints a frame's stroke under its children unless
the frame clips them, so the artifact list and the tables, whose rows reach their edges, clip as they do in CSS.

## Behavior the static design does not show

- **Version.** The header shows the root `package.json`'s version (`v0.3.0` in the design), which the build inlines
  into the Worker as it does into the CLI. The Worker is deployed from the release branch, so the version is the
  release's.
- **Current section.** `/` and an artifact that is not archived mark Active; `/archived` and an archived artifact mark
  Archived.
- **A row's description** stays on one line and ends with an ellipsis; the artifact page shows it whole, and the row's
  title links there.
- **Archived rows** end their meta line with the reason: `archived by hand` or `archived: no updates for N days`.
- **Narrow widths.** `main` keeps a `space.4` gutter. Under 36rem of the list's width an artifact row puts its open link
  under the summary; under 36rem of a table's own width (`.data-table` is the query container) the table becomes one
  card per row, each cell prefixed by its `data-label`. The header row is hidden visually but stays for screen readers,
  and the prefix is hidden from them.
- **Times** are UTC, `YYYY-MM-DD HH:MM`, in `<time datetime="YYYY-MM-DDTHH:MM:00Z">`; list rows show a relative time
  (`2 hours ago`) with the same `datetime`.
- **Focus.** Links and the scrollable table regions show `focus.width` of `color.focus` on `:focus-visible`.
- **Contrast.** Every text color is at least 5.8:1 on its background (the lowest is `color.badge.neutral.fg` on
  `color.badge.neutral.bg`). Borders are separators, not control boundaries; the current tab is also marked by its
  weight and `aria-current`.
