import { expect, gate, test } from "./fixtures";

test("the opening tracks the village's loading bar until its pictures arrive", async ({ page }) => {
  // The pictures wait until the bar has been seen.
  const pictures = gate();
  await page.route("**/pixel/*.png", async (route) => {
    await pictures.opened;
    await route.continue();
  });
  // Not to "load": that waits for the pictures, which wait for the bar to be seen.
  await page.goto("/farm/", { waitUntil: "domcontentloaded" });
  const bar = page.getByTestId("village-loading");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("aria-valuenow", /^\d+$/u);
  await expect(page.locator("#opening")).toBeVisible();
  await expect(page.locator("#opening")).toHaveAttribute("data-mood", "excited");
  expect(Number(await page.locator("#opening").getAttribute("data-progress"))).toBeLessThan(100);
  pictures.open();
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(bar).toHaveCount(0);
  await expect(page.locator("#opening")).toHaveCount(0);
});

test("the village becomes ready after workbench navigation and history", async ({ page }) => {
  await page.goto("/farm/");
  await page.getByTestId("to-workbench").click();
  await expect(page).toHaveURL(/\/issues$/u);
  await page.getByTestId("rail").locator('[data-place="farm"]').first().click();
  await expect(page).toHaveURL(/\/farm$/u);
  const village = page.getByTestId("village");
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByTestId("farm").locator("canvas")).toBeVisible();
  await page.getByTestId("to-workbench").click();
  await expect(page).toHaveURL(/\/issues$/u);
  await expect(page.getByTestId("issue-search")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/farm$/u);
  await expect(village).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByTestId("farm").locator("canvas")).toBeVisible();
});
