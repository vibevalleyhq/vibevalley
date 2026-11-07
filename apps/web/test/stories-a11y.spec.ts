import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./stories-fixtures";

test.use({ viewport: { width: 1680, height: 1000 } });
const titles = readdirSync(join(import.meta.dirname, "..", "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".stories.tsx"))
  .map((file) => /title: "([^"]+)"/u.exec(readFileSync(join(import.meta.dirname, "..", "src", file), "utf8"))?.[1] ?? file);

for (const title of titles)
  test(`${title}: each story draws in each of its themes with nothing for axe to find`, async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("stories-search").fill(title);
    const keys = await page
      .locator(`[data-testid="story-link"][data-key^="${title}:"]`)
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-key")!));
    expect(keys.length, `no stories titled ${title}`).toBeGreaterThan(0);
    const found: string[] = [];
    for (const key of keys)
      await test.step(`audit: ${key}`, async () => {
        // A fresh document cannot reuse a completed audit from the preceding story.
        await page.goto(`/?${new URLSearchParams({ s: key, theme: "both", w: "full" })}`);
        await expect(page.getByTestId("story-frame").first()).toBeVisible();
        const audit = page.getByTestId("story-a11y");
        await expect(audit).toHaveAttribute("data-count", /^\d+$/u);
        if ((await audit.getAttribute("data-count")) !== "0") {
          await audit.click();
          found.push(`${key}: ${await page.getByTestId("story-a11y-panel").innerText()}`);
        }
        if ((await page.getByTestId("story-error").count()) > 0) found.push(`${key}: ${await page.getByTestId("story-error").first().innerText()}`);
      });
    expect(found).toEqual([]);
  });

test("regression: syntax-highlighted code remains readable in both themes", async ({ page }, info) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Markdown:Folded code", theme: "both", w: "400" })}`);
  await expect(page.getByTestId("story-frame")).toHaveCount(2);
  for (const frame of await page.getByTestId("story-frame").all()) {
    await expect(frame.getByTestId("code-block").locator("span[style]").first()).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).include('[data-testid="story-frame"]').analyze()).violations).toEqual([]);
  await page.getByTestId("story-canvas").screenshot({ path: info.outputPath("highlighted-code.png") });
});

for (const theme of ["light", "dark"]) {
  test(`regression: form errors render in an actual 400px frame in ${theme}`, async ({ page }, info) => {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Form:Receipts", theme, w: "400" })}`);
    await expect(page.getByTestId("story-frame")).toHaveCSS("width", "400px");
    await page.getByTestId("form-submit").click();
    await expect(page.getByTestId("form-name")).toHaveAttribute("aria-invalid", "true");
    expect((await new AxeBuilder({ page }).include('[data-testid="story-frame"]').analyze()).violations).toEqual([]);
    await page.getByTestId("story-frame").screenshot({ path: info.outputPath(`form-${theme}-400.png`) });
  });
}

test("table controls remain accessible on a narrow page after selection and hiding a column", async ({ page }, info) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/DataTable:Local", theme: "light", w: "400" })}`);
  await expect(page.getByTestId("story-frame")).toHaveCSS("width", "400px");
  await page.getByTestId("table-row").first().getByTestId("table-select-row").click();
  await page.locator('[data-testid="table-column"][data-key="count"]').click();
  expect((await new AxeBuilder({ page }).include('[data-testid="story-frame"]').analyze()).violations).toEqual([]);
  await page.getByTestId("story-frame").screenshot({ path: info.outputPath("table-400.png") });
});
