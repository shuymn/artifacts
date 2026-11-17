/**
 * The viewer's menu icons (docs/gallery/design.md, `menu-item` and `icon-button`): Lucide icons as the design file
 * draws them, inline SVG in the text's color (`currentColor`), sized by viewer.css. Their shapes are copied from
 * lucide-static 1.73.0 under the licenses below.
 *
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors. Permission to use, copy, modify, and/or distribute
 * this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and
 * this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT
 * SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Of these, arrow-left, arrow-up-right, check, chevron-right, download, ellipsis (Feather's more-horizontal), info, lock
 * and trash-2 are derived from the
 * Feather project: The MIT License (MIT). Copyright (c) 2013-present Cole Bemis. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished
 * to do so, subject to the following conditions: The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY
 * OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { html, type Markup } from "./html.ts";

const SHAPES = {
  "arrow-left": html`<path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path>`,
  "arrow-up-right": html`<path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>`,
  check: html`<path d="M20 6 9 17l-5-5"></path>`,
  "chevron-right": html`<path d="m9 18 6-6-6-6"></path>`,
  download: html`<path d="M12 15V3"></path><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path
    ><path d="m7 10 5 5 5-5"></path>`,
  ellipsis: html`<circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle
    ><circle cx="5" cy="12" r="1"></circle>`,
  globe: html`<circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path
    ><path d="M2 12h20"></path>`,
  history: html`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path
    ><path d="M12 7v5l4 2"></path>`,
  info: html`<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>`,
  "layout-grid": html`<rect width="7" height="7" x="3" y="3" rx="1"></rect
    ><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect
    ><rect width="7" height="7" x="3" y="14" rx="1"></rect>`,
  lock: html`<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>`,
  "square-arrow-out-up-right": html`<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"></path
    ><path d="m21 3-9 9"></path><path d="M15 3h6v6"></path>`,
  "trash-2": html`<path d="M10 11v6"></path><path d="M14 11v6"></path
    ><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path
    ><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>`,
} as const;

export type IconName = keyof typeof SHAPES;

/** An icon as inline SVG with `class` (its size and place in viewer.css), hidden from assistive technology. */
export function icon(name: IconName, className: string): Markup {
  return html`<svg
    class="${className}"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${SHAPES[name]}
  </svg>`;
}
