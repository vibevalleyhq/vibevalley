import AxeBuilder from "@axe-core/playwright";

import { diagnosticsOf } from "./browser";
import { expect, settled, test } from "./fixtures";

test.use({ farm: "a11y" });

for (const width of [1440, 390])
  test(`farm and opening layouts fit ${width}px`, async ({ page }, info) => {
    const check = diagnosticsOf(page);
    await page.setViewportSize({ width, height: 844 });
    await test.step("audit: farm layout", async () => {
      await page.goto("/farm/");
      await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
      await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
      await expect(page.locator("#opening")).toHaveCount(0);
      await settled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`farm-${width}.png`), animations: "disabled" });
    });
    await test.step("audit: opening layout", async () => {
      await page.goto("/opening.html");
      await settled(page);
      await expect(page.getByRole("progressbar")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`opening-${width}.png`), animations: "disabled" });
    });
    check();
  });
