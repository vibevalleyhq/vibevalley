import { expect, gate, test } from "./fixtures";

// The title screen shows on a machine's first visit; these tests start past it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("the opening hands off to the village's loading bar before its pictures arrive", async ({ page }) => {
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
  await expect(page.locator("#opening")).toHaveCount(0);
  pictures.open();
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(bar).toHaveCount(0);
});

test("the farm links to the workbench, and the workbench back to the farm", async ({ page }) => {
  await page.goto("/farm/");
  await page.getByTestId("to-workbench").click();
  await expect(page).toHaveURL(/\/issues$/u);
  await page.getByTestId("rail").locator('[data-place="farm"]').first().click();
  await expect(page).toHaveURL(/\/farm$/u);
  await expect(page.getByTestId("farm").locator("canvas")).toBeVisible();
});
