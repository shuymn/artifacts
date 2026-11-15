# Gallery design system

The gallery's screens are designed in Penpot from the tokens and components below, and the code implements the same
tokens and components by name. A change goes to both: the Penpot file first, then [`tokens.json`](tokens.json) and the
code. Behavior and content of each page are in [design.md](../design.md), section 10.

## Ground rules

- **Dark only.** The owner uses a dark color scheme, so the gallery has one theme: `:root { color-scheme: dark; }` and
  the colors below. A light theme would be a second token set with the same names.
- **No script, forms or frames** (design.md, section 10). Every state is a link or plain markup.
- **Text scales with the user's setting.** The page opts in with `<meta name="text-scale" content="scale">`, never sets
  a root `font-size`, and sizes text and the spacing around text in `rem`.
- **Fonts are served by the Worker.** IBM Plex Sans and IBM Plex Mono (Latin subsets, `woff2`, `font-display: swap`),
  with `system-ui` / `ui-monospace` fallbacks and `font-size-adjust: from-font`, so Japanese titles fall back to the
  system font at the same x-height.

## Tokens

[`tokens.json`](tokens.json) is the export of the Penpot token set `artifacts` in the Design Tokens Community Group
format, and the source the code's custom properties are checked against.

| Token                                     | CSS                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| any token `a.b.c`                         | the custom property `--a-b-c` on `:root` (`space.0-5` → `--space-0-5`)   |
| `color.*`                                 | the hex value; `color.focus` is `var(--color-accent)`                    |
| `space.*`, `font.size.*`, `size.*`        | `px ÷ 16` in `rem` (`space.4` 16px → `1rem`)                             |
| `radius.*`, `border.width`, `focus.width` | `px`                                                                     |
| `font.family.sans`                        | `"IBM Plex Sans", system-ui, sans-serif`                                 |
| `font.family.mono`                        | `"IBM Plex Mono", ui-monospace, monospace`                               |
| `font.weight.*`                           | the number                                                               |
| `type.*` (typography)                     | no custom property: the four declarations, written where a class uses it |

Values Penpot shows that are not tokens (a text's measured width, a board's height) are not part of the design.

## Components

Each Penpot component is one HTML pattern with one class. A variant is a modifier class or an attribute.

| Penpot component  | Variants                                      | HTML                                                                                                              | Tokens                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-header`     | —                                             | `<header class="site-header">` with `.brand` and `<nav class="site-nav">`                                         | `color.bg`; padding `space.3` / `space.7`; bottom border `border.width` `color.border`                                                                                                                                                      |
| (brand text)      | —                                             | `<a class="brand" href="/">artifacts</a>`                                                                         | `type.brand`, `color.text`                                                                                                                                                                                                                  |
| `nav-tab`         | `state=default`, `state=current`              | `<a class="nav-tab">` with `<span class="nav-tab__count">`; current: `aria-current="page"`                        | padding `space.1` / `space.3`, gap `space.2`, `radius.sm`; default `type.nav` `color.text-muted`; current `type.nav-current` `color.text`, `color.surface`, border `color.border`; count `type.meta` `color.text-muted`                     |
| `artifact-row`    | —                                             | `<li class="artifact-row">` in `<ul class="artifact-list">`                                                       | padding `space.3` / `space.4`, gap `space.6`; title `type.row-title` `color.text` (a link to `/a/<id>`); description `type.body-sm` `color.text-muted`, one line; meta `type.meta` `color.text-muted`; open link `type.link` `color.accent` |
| `badge`           | `kind=public`, `kind=archived`, `kind=latest` | `<span class="badge badge--public">` (`--archived`, `--latest`)                                                   | padding `space.0-5` / `space.2`, `radius.pill`, `type.label`; public `color.badge.public.*`; archived and latest `color.badge.neutral.*`                                                                                                    |
| `pager`           | —                                             | `<nav class="pager" aria-label="Pagination">` with one link                                                       | `type.link`, `color.accent`, aligned to the end                                                                                                                                                                                             |
| `back-link`       | —                                             | `<a class="back-link" href="/">← Artifacts</a>`                                                                   | `type.link`, `color.accent`                                                                                                                                                                                                                 |
| `section-heading` | —                                             | `<h2 class="section-heading">` with `<span class="section-heading__count">`                                       | gap `space.2`; title `type.section-title` `color.text`; count `type.meta` `color.text-muted`                                                                                                                                                |
| `info-row`        | `value=text`, `value=link`                    | `<div class="info-row"><dt>…</dt><dd>…</dd></div>` in `<dl class="info">`; link: `<dd class="info-row__link"><a>` | gap `space.4`; term width `size.label`, `type.body-sm` `color.text-muted`; text `type.body-sm` `color.text`; link `type.code` `color.accent`                                                                                                |
| `table-cell`      | `style=head`, `text`, `mono`, `muted`, `link` | `<th>` (head) or `<td class="cell--mono">` (`--muted`, `--link`; text has no modifier)                            | padding `space.2` / `space.4`; head `type.label` `color.text-muted` on `color.surface`; text `type.body-sm` `color.text`; mono `type.code` `color.text`; muted `type.code` `color.text-muted`; link `type.link` `color.accent`              |

Patterns the screens compose from those components, with their tokens:

| Pattern          | HTML                                                                                                 | Tokens                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Page             | `<body>`: `.site-header`, then `<main class="page">`                                                 | `color.bg`; `main` width `min(size.content, 100% − 2 × space.4)`, top padding `space.8` (lists) or `space.7` (detail), bottom `space.9` |
| Page heading     | `<hgroup class="page-heading"><h1>` + `<p>`                                                          | gap `space.1`; `type.page-title` `color.text`; subtitle `type.body-sm` `color.text-muted`                                               |
| Artifact list    | `<ul class="artifact-list">`                                                                         | `radius.md`, border `color.border`; rows separated by a `border.width` `color.border` line                                              |
| Artifact heading | `<header class="artifact-heading">`: `<h1>` with badges, `<p class="artifact-heading__description">` | gap `space.2`; `type.page-title`; description `type.body` `color.text-muted`, wraps                                                     |
| Info card        | `<dl class="info">`                                                                                  | padding `space.4` / `space.5`, gap `space.3`, `radius.md`, `color.surface`, border `color.border`                                       |
| Data table       | `<div class="data-table" role="region" tabindex="0" aria-labelledby="…">` around `<table>`           | `radius.md`, border `color.border`; rows separated by `color.border`                                                                    |
| Section          | `<section>`: `.section-heading`, the table, an optional `.pager`                                     | gap `space.3`; sections separated by `space.7`                                                                                          |
| Focus            | every link                                                                                           | `outline: focus.width solid color.focus`, offset `space.0-5`, on `:focus-visible`                                                       |

## Behavior the static design does not show

- **Current section.** The nav tab of the list a page belongs to is current: `/` and an artifact that is not archived
  mark Active; `/archived` and an archived artifact mark Archived.
- **Description in a row** stays on one line and ends with an ellipsis (`text-overflow: ellipsis`); the artifact page
  shows it whole. The row's title link is the way to the full text, so no reveal is added.
- **Archived rows** add the reason to the meta line: `archived by hand` or `archived: no updates for N days`.
- **Narrow widths.** `main` keeps a `space.4` gutter. An artifact row stacks the open link under the summary when its
  container is narrower than 36rem. A data table becomes stacked cards under 36rem of its own width (a container query),
  each cell labelled with its column name; its region scrolls instead of the page when a value cannot wrap.
- **Times** are rendered by the server in UTC as `YYYY-MM-DD HH:MM` in `<time datetime="…">`; list rows use a relative
  form (`2 hours ago`) with the absolute time in the `datetime` attribute.
- **Contrast.** Every text color is at least 5.8:1 on the background it sits on (the lowest is `color.badge.neutral.fg`
  on `color.badge.neutral.bg`). Borders are separators, not control boundaries; the current tab is also marked by its
  weight and `aria-current`.
