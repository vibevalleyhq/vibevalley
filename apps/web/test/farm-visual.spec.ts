import { expect, settled, test } from "./fixtures";

test.use({ farm: "farm-visual" });

test("capture the live farm for visual inspection in daylight and at night", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  for (const [name, path] of [
    ["day", "/farm/?tod=0.5"],
    ["night", "/farm/?tod=0.95"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
    await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
    await expect(page.locator("#opening")).toHaveCount(0);
    await settled(page);
    await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
  }
});
