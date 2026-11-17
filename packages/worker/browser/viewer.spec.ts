// The viewer frame's script in browsers (design.md section 6, "The script"; PL-55), and the confirmation popup it
// opens (section 10; PL-58's browser part), against the Worker in the local runtime.
import { expect, test, type Frame, type Page } from "@playwright/test";

import { appOrigin, contentOrigin, create, update, withoutPopover } from "./support.ts";

/**
 * A page that fills the viewport and shows its fragment, links to another page of the artifact, to version 1 and to
 * another origin, and a second page that pushes a history entry.
 */
function probe(other = "http://example.invalid/"): Record<string, string> {
  return {
    "index.html": `<!doctype html><title>probe</title>
<style>* { margin: 0 } html, body { height: 100vh; background: teal }</style>
<p id="hash"></p>
<a id="two" href="two.html">two</a> <a id="pinned" href="/_v/1/">v1</a> <a id="latest" href="/">latest</a>
<a id="other" href="${other}">other</a>
<script>document.getElementById("hash").textContent = location.hash;</script>`,
    "two.html": `<!doctype html><title>two</title>
<button id="push" onclick="history.pushState(null, '', '?step=2')">push</button>
<a id="latest" href="/">latest</a>`,
  };
}

const frameOf = (page: Page) => page.frameLocator("#viewer-frame");

/** The iframe's document, once it shows `path` of the artifact. */
async function framedAt(page: Page, path: string): Promise<Frame> {
  const find = () =>
    page.frames().find((frame) => frame !== page.mainFrame() && new URL(frame.url()).pathname === path);
  await expect.poll(() => find() !== undefined).toBe(true);
  const frame = find();
  if (frame === undefined) throw new Error(`no frame at ${path}`);
  return frame;
}

/** Whether a panel shows, by its box: popover and `hidden` both remove it from the layout. */
const shows = (page: Page, selector: string) => page.locator(selector).isVisible();

test.describe("PL-55: the frame's script", () => {
  test("starts the iframe at the page's URL with its fragment, under a header that does not cover it", async ({
    page,
  }) => {
    const id = await create("Probe", probe());
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${contentOrigin(id)}/#x`);
    await expect(page.locator(".viewer-header__version")).toHaveText("v1 · latest");
    await expect(frameOf(page).locator("#hash")).toHaveText("#x");
    await expect(page).toHaveTitle("probe");
    expect(page.url()).toBe(`${contentOrigin(id)}/#x`);
    // The page fills its own viewport, the iframe, without scrolling; nor does the frame page.
    const inner = await framedAt(page, "/");
    expect(await inner.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    const box = await page.locator("#viewer-frame").boundingBox();
    const header = await page.locator(".viewer-header").boundingBox();
    expect(box?.y).toBe((header?.y ?? 0) + (header?.height ?? 0));
    expect(errors).toEqual([]);
  });

  test("copies the iframe's URL and title to the top after a link and a pushState", async ({ page }) => {
    const id = await create("Probe", probe());
    await page.goto(`${contentOrigin(id)}/`);
    await frameOf(page).locator("#two").click();
    await expect(page).toHaveURL(`${contentOrigin(id)}/two.html`);
    await expect(page).toHaveTitle("two");
    await expect(page.locator("#viewer-direct")).toHaveAttribute("href", "/two.html?_viewer=off");
    await frameOf(page).locator("#push").click();
    const navigation = await page.evaluate(() => "navigation" in window);
    // Best effort: only the Navigation API reports a pushState; elsewhere the address keeps the last loaded URL.
    await expect(page).toHaveURL(`${contentOrigin(id)}/two.html${navigation ? "?step=2" : ""}`);
  });

  test("keeps the artifact's last URL when the iframe shows another origin", async ({ page }) => {
    const other = await create("Other", { "index.html": "<title>elsewhere</title>" });
    const id = await create("Probe", probe(`${contentOrigin(other)}/`));
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");
    await frameOf(page).locator("#other").click();
    await expect.poll(() => page.frames().some((frame) => frame.url() === `${contentOrigin(other)}/`)).toBe(true);
    await expect
      .poll(() =>
        page
          .frames()
          .find((frame) => frame.url() === `${contentOrigin(other)}/`)
          ?.title(),
      )
      .toBe("elsewhere");
    expect(page.url()).toBe(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");
    expect(errors).toEqual([]);
  });

  test("focuses the iframe at its first load only", async ({ page }) => {
    const id = await create("Probe", probe());
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("viewer-frame");
    const inner = await framedAt(page, "/");
    expect(await inner.evaluate(() => document.hasFocus())).toBe(true);
    // A second load leaves the focus where the owner put it.
    await page.locator(".icon-button").focus();
    await inner.evaluate(() => {
      location.href = "two.html";
    });
    await expect(page).toHaveTitle("two");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("icon-button");
  });

  test("follows a navigation to a pinned version and back in the header and the menu", async ({ page }) => {
    const id = await create("Probe", probe());
    await update(id, 1, { "index.html": "<!doctype html><title>second</title><a id='pinned' href='/_v/1/'>v1</a>" });
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page.locator(".viewer-header__version")).toHaveText("v2 · latest");
    await frameOf(page).locator("#pinned").click();
    await expect(page).toHaveURL(`${contentOrigin(id)}/_v/1/`);
    await expect(page.locator(".viewer-header__version")).toHaveText("v1 of 2");
    await expect(page.locator(".viewer-menu__shown")).toHaveText(/^v1 · published \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(page.locator(".viewer-history li a[aria-current=page]")).toHaveAttribute("href", "/_v/1/");
    await expect(page.locator("#viewer-export")).toHaveAttribute("href", `${appOrigin()}/a/${id}/v/1/export`);
    await expect(page.locator("#viewer-export .menu-item__label")).toHaveText("Export v1 (.zip)");
    await frameOf(page).locator("#latest").click();
    await expect(page).toHaveURL(`${contentOrigin(id)}/`);
    await expect(page.locator(".viewer-header__version")).toHaveText("v2 · latest");
    await expect(page.locator(".viewer-menu__shown")).toHaveText(/^v2 · updated /);
    await expect(page.locator(".viewer-history li a[aria-current=page]")).toHaveAttribute("href", "/");
    await expect(page.locator("#viewer-export")).toHaveAttribute("href", `${appOrigin()}/a/${id}/v/2/export`);
  });

  test("closes the menu on a click in the iframe", async ({ page }) => {
    const id = await create("Probe", probe());
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");
    await page.locator(".icon-button").click();
    await expect(page.locator("#viewer-menu")).toBeVisible();
    await frameOf(page)
      .locator("body")
      .click({ position: { x: 200, y: 200 } });
    await expect(page.locator("#viewer-menu")).toBeHidden();
  });

  test.describe("without script", () => {
    test.use({ javaScriptEnabled: false });

    test("links to the page directly", async ({ page }) => {
      const id = await create("Probe", probe());
      await page.goto(`${contentOrigin(id)}/`);
      const direct = page.locator(".viewer-header__direct");
      await expect(direct).toHaveAttribute("href", "/?_viewer=off");
      await direct.click();
      await expect(page).toHaveURL(`${contentOrigin(id)}/?_viewer=off`);
      await expect(page.locator(".viewer-header")).toHaveCount(0);
      await expect(page.locator("#two")).toBeVisible();
    });
  });

  test.describe("in a browser without popover", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(withoutPopover);
    });

    test("opens and closes the menu and the history itself", async ({ page }) => {
      const id = await create("Probe", probe());
      await page.goto(`${contentOrigin(id)}/`);
      await expect(page).toHaveTitle("probe");
      expect(await page.evaluate(() => "popover" in HTMLElement.prototype)).toBe(false);
      await expect(page.locator("[popover], [popovertarget]")).toHaveCount(0);
      expect(await shows(page, "#viewer-menu")).toBe(false);
      expect(await shows(page, "#viewer-history")).toBe(false);

      const button = page.locator(".icon-button");
      await button.click();
      await expect(page.locator("#viewer-menu")).toBeVisible();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await page.locator("#viewer-menu button").click();
      await expect(page.locator("#viewer-history")).toBeVisible();
      // Escape closes the history, then the menu.
      await page.keyboard.press("Escape");
      await expect(page.locator("#viewer-history")).toBeHidden();
      await expect(page.locator("#viewer-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#viewer-menu")).toBeHidden();
      await expect(button).toHaveAttribute("aria-expanded", "false");

      // A click outside the lists closes both.
      await button.click();
      await page.locator("#viewer-menu button").click();
      await page.locator(".viewer-header__title").click();
      await expect(page.locator("#viewer-history")).toBeHidden();
      await expect(page.locator("#viewer-menu")).toBeHidden();

      // So does a click in the iframe.
      await button.click();
      await page.locator("#viewer-menu button").click();
      await frameOf(page)
        .locator("body")
        .click({ position: { x: 200, y: 200 } });
      await expect(page.locator("#viewer-history")).toBeHidden();
      await expect(page.locator("#viewer-menu")).toBeHidden();
    });
  });
});

test.describe("PL-58: the confirmation popup", () => {
  test("sends the viewer to the artifact, then to the gallery, and closes", async ({ page }) => {
    const id = await create("Probe", probe());
    const methods: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(contentOrigin(id))) methods.push(request.method());
    });
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");

    await page.locator(".icon-button").click();
    const [visibility] = await Promise.all([page.waitForEvent("popup"), page.getByText("Make public…").click()]);
    await expect(visibility).toHaveURL(`${appOrigin()}/a/${id}/public`);
    expect(await visibility.evaluate(() => window.opener !== null)).toBe(true);
    await Promise.all([
      visibility.waitForEvent("close"),
      visibility.getByRole("button", { name: "Make public" }).click(),
    ]);
    await expect(page).toHaveURL(`${contentOrigin(id)}/`);
    await expect(page.locator("#viewer-menu a[target=_blank]").first()).toHaveText("Make private…");

    await page.locator(".icon-button").click();
    const [deletion] = await Promise.all([page.waitForEvent("popup"), page.getByText("Delete…").click()]);
    await expect(deletion).toHaveURL(`${appOrigin()}/a/${id}/delete`);
    await Promise.all([deletion.waitForEvent("close"), deletion.getByRole("button", { name: "Delete" }).click()]);
    await expect(page).toHaveURL(`${appOrigin()}/`);

    // ISO-3: the frame page and the artifact sent no write of their own.
    expect(methods.filter((method) => method !== "GET")).toEqual([]);
  });

  test("leaves the page opened as a tab, without an opener, with its links", async ({ page, context }) => {
    const id = await create("Probe", probe());
    // A blocked popup: the item is followed as its link, a new tab without an opener.
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.goto(`${contentOrigin(id)}/`);
    await expect(page).toHaveTitle("probe");
    await page.locator(".icon-button").click();
    const [tab] = await Promise.all([context.waitForEvent("page"), page.getByText("Make public…").click()]);
    await expect(tab).toHaveURL(`${appOrigin()}/a/${id}/public`);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.getByRole("button", { name: "Make public" }).click();
    await expect(tab.getByRole("heading", { name: "The artifact is public" })).toBeVisible();
    await expect(tab.getByRole("link", { name: "All artifacts" })).toBeVisible();
    expect(tab.isClosed()).toBe(false);
    expect(page.url()).toBe(`${contentOrigin(id)}/`);
  });
});
