import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures";

test.use({ farm: "slides" });

// The deck's own words, as the test wrote them: the second slide's notes are checked in the speaker's window.
const secondNotes = "提一下覆盖率";
const deck = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>周报</title></head><body>
<section class="title"><h1>周报</h1><p>第 43 周</p><aside class="notes">先说结论</aside></section>
<section><h2>做完了</h2><ul><li>查询接口</li><li>三十条测试</li></ul><aside class="notes">${secondNotes}</aside></section>
<section class="quote"><blockquote>一次拿到。</blockquote><cite>评审</cite></section>
</body></html>`;

test("a deck pages by its controls, its thumbnails and its keys, follows the speaker's window, and prints a slide a page", async ({ page, api, context }) => {
  const made = await api.artifact.create({ title: "周报", kind: "html", display: "slides", content: deck });
  expect(made.display).toBe("slides");
  await page.goto(`/artifacts/${made.id}`);
  const controls = page.getByTestId("slides-controls");
  await expect(controls).toHaveAttribute("data-pages", "3");
  await expect(controls).toHaveAttribute("data-at", "0");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

  await page.getByTestId("slides-next").click();
  await expect(controls).toHaveAttribute("data-at", "1");
  await page.locator('[data-testid="slides-thumb"][data-page="2"]').click();
  await expect(controls).toHaveAttribute("data-at", "2");
  await expect(page.getByTestId("slides-next")).toBeDisabled();
  await page.getByTestId("slides-previous").click();
  await expect(controls).toHaveAttribute("data-at", "1");

  // The deck's own clicks and keys, inside its frame: a click right of its first quarter goes on.
  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await frame.locator("body").click({ position: { x: 600, y: 200 } });
  await expect(controls).toHaveAttribute("data-at", "2");
  await page.keyboard.press("Home");
  await expect(controls).toHaveAttribute("data-at", "0");
  await page.keyboard.press("ArrowRight");
  await expect(controls).toHaveAttribute("data-at", "1");
  await page.keyboard.press("ArrowLeft");
  await expect(controls).toHaveAttribute("data-at", "0");

  // The speaker's window: its next moves the workbench's tab too, and it shows that slide's notes.
  const opened = context.waitForEvent("page");
  await page.getByTestId("slides-presenter").click();
  const speaker = await opened;
  await expect(speaker.getByTestId("presenter")).toHaveAttribute("data-pages", "3");
  await speaker.getByTestId("presenter-next").click();
  await expect(speaker.getByTestId("presenter-notes")).toHaveText(secondNotes);
  await expect(controls).toHaveAttribute("data-at", "1");
  await page.getByTestId("slides-next").click();
  await expect(speaker.getByTestId("presenter")).toHaveAttribute("data-at", "2");
  await speaker.close();

  // Printed, every slide is its own page. (?print=1 also opens the print dialog, which a test cannot answer.)
  const printed = await context.newPage();
  await printed.emulateMedia({ media: "print" });
  await printed.goto(`/api/v1/artifact/${made.id}/1?shell=1&display=slides&theme=light`);
  const laid = await printed.locator("section").evaluateAll((all) => {
    const shown: string[][] = [];
    for (const s of all) shown.push([getComputedStyle(s).display, getComputedStyle(s).position, getComputedStyle(s).breakAfter]);
    return shown;
  });
  expect(laid).toEqual(Array.from({ length: 3 }, () => ["flex", "relative", "page"]));
});
