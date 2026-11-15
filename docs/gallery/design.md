# Gallery design system

The gallery's screens are designed in Penpot from a token set and components, and the code uses the same tokens and
components by name. Three files carry the design into the code, and the implementation follows them exactly:

- [`tokens.json`](tokens.json): the Penpot token set `artifacts`.
- [`gallery.css`](../../packages/worker/src/gallery/gallery.css): the stylesheet the Worker serves. Every token is a
  custom property, every component a class.
- [`reference/`](reference/): one static page per screen (`index.html`, `archived.html`, `artifact.html`) with the
  markup the Worker's templates must produce. They load `gallery.css` and render like the Penpot screens.

A design change goes to all of them: the Penpot file first, then `tokens.json`, `gallery.css` and the reference pages,
then the templates. Content and behavior of each page are in [design.md](../design.md), section 10.

## Ground rules

- **Dark only.** The owner uses a dark color scheme, so the gallery has one theme (`color-scheme: dark`). A light theme
  would be a second token set with the same names.
- **No script, forms or frames** (design.md, section 10). Every state is a link or plain markup.
- **Text scales with the user's setting.** Each page has `<meta name="text-scale" content="scale">`, no rule sets a
  root `font-size`, and text and the spacing around it are in `rem`.
- **Fonts are served by the Worker**: IBM Plex Sans and IBM Plex Mono (Latin subsets, `woff2`,
  `font-display: swap`) in a separate `@font-face` stylesheet. `gallery.css` falls back to `system-ui` and
  `ui-monospace` with `font-size-adjust: from-font`, so Japanese text falls back to the system font at the same
  x-height. The reference pages load the same fonts from Google Fonts instead, for previewing only.

## Tokens

`tokens.json` has the Design Tokens format's shape as Penpot exports it: `$type` and `$value` per token, dimensions as
strings with `px`, typography without letter spacing. It is not checked against the DTCG schema; the code checks its
custom properties against it.

| Token                                       | In `gallery.css`                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every token except `type.*` and `size.page` | the custom property `--a-b-c` for `a.b.c` on `:root` (`space.0-5` → `--space-0-5`)                                                                                                                            |
| `color.*`                                   | the hex value; a reference (`{color.accent}`) becomes `var(--color-accent)`                                                                                                                                   |
| `space.*`, `font.size.*`, `size.*`          | `px ÷ 16` in `rem` (`space.4`: 16px → `1rem`)                                                                                                                                                                 |
| `radius.*`, `border.width`, `focus.width`   | `px`                                                                                                                                                                                                          |
| `font.family.sans` / `font.family.mono`     | the family, then `system-ui, sans-serif` / `ui-monospace, monospace`                                                                                                                                          |
| `font.weight.*`                             | the number                                                                                                                                                                                                    |
| `type.x` (typography)                       | one rule, headed by the comment `/* type.x */`, whose `font` shorthand is `var(--font-weight-…) var(--font-size-…) / <line height> var(--font-family-…)`; the selectors listed are every element that uses it |
| `size.page`                                 | none: it is the width of the Penpot screens, not of the page                                                                                                                                                  |

Values Penpot shows that are not tokens (a text's measured width, a board's height, the width of a table column) are
not part of the design.

## Components

Each Penpot component is one class in `gallery.css`; a variant is a modifier class or an attribute. The reference pages
show each in place.

| Penpot component  | Variant                                         | Markup                                                                                                          |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `site-header`     |                                                 | `header.site-header` > `a.brand` + `nav.site-nav`                                                               |
| `nav-tab`         | `state=default`                                 | `a.nav-tab` > text + `span.nav-tab__count`                                                                      |
|                   | `state=current`                                 | the same with `aria-current`: `"page"` on the list it links to, `"true"` on an artifact page in that section    |
| `artifact-row`    |                                                 | `li.artifact-row` in `ul.artifact-list`; see `reference/index.html`                                             |
| `badge`           | `kind=public` / `kind=archived` / `kind=latest` | `span.badge.badge--public` / `.badge--archived` / `.badge--latest`                                              |
| `pager`           |                                                 | `nav.pager` with an `aria-label` > one `a`                                                                      |
| `back-link`       |                                                 | `a.back-link`                                                                                                   |
| `section-heading` |                                                 | `h2.section-heading` with an `id` > text + `span.section-heading__count`                                        |
| `info-row`        | `value=text`                                    | `div.info-row` > `dt` + `dd`, in `dl.info`                                                                      |
|                   | `value=link`                                    | the same with `dd.info-row__link` > `a`                                                                         |
| `table-cell`      | `style=head`                                    | `thead th[scope=col]`                                                                                           |
|                   | `style=text` / `mono` / `muted` / `link`        | `td` / `td.cell--mono` / `td.cell--muted` / `td.cell--link` > `a`; every `td` has `data-label`, its column name |

Screens also use `main.page` (`.page--detail` on an artifact page), `hgroup.page-heading`, `header.artifact-heading`,
`section.section` and `div.data-table[role=region][tabindex=0][aria-labelledby]` around each `table`; `.cell--grow`
marks the column that takes the remaining width (the version title, the file path).

Penpot draws a container's stroke inside its box, and CSS draws a border outside the padding, so content inside a
bordered container sits one pixel further in. The nav tab subtracts its border from its padding, because its size is
part of the design; the other containers keep the one pixel.

## Behavior the static design does not show

- **Current section.** `/` and an artifact that is not archived mark Active; `/archived` and an archived artifact mark
  Archived.
- **A row's description** stays on one line and ends with an ellipsis; the artifact page shows it whole, and the row's
  title links there.
- **Archived rows** end their meta line with the reason: `archived by hand` or `archived: no updates for N days`.
- **Narrow widths.** `main` keeps a `space.4` gutter. Under 36rem of the list's width an artifact row puts its open link
  under the summary; under 36rem of a table's own width (`.data-table` is the query container) the table becomes one
  card per row, without the header row, each cell prefixed by its `data-label`.
- **Times** are UTC, `YYYY-MM-DD HH:MM`, in `<time datetime="YYYY-MM-DDTHH:MM:00Z">`; list rows show a relative time
  (`2 hours ago`) with the same `datetime`.
- **Focus.** Links and the scrollable table regions show `focus.width` of `color.focus` on `:focus-visible`.
- **Contrast.** Every text color is at least 5.8:1 on its background (the lowest is `color.badge.neutral.fg` on
  `color.badge.neutral.bg`). Borders are separators, not control boundaries; the current tab is also marked by its
  weight and `aria-current`.
