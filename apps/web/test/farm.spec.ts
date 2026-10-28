import { expect, gate, test } from "./fixtures";

// The title screen shows on a machine's first visit; these tests start past it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("/ draws the farm on a canvas, without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/farm/");
  const canvas = page.getByTestId("farm").locator("canvas");
  await expect(canvas).toBeVisible();
  // At 1280 × 800 the village (384 × 256) is drawn three times over, with narrow bars.
  await expect(canvas).toHaveCSS("width", "1152px");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("while the village's pictures come in, a bar says how far; drawn, it goes", async ({ page }) => {
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
  await expect(bar).toHaveAttribute("aria-valuenow", /^\d+$/);
  pictures.open();
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(bar).toHaveCount(0);
});

test("the farm links to the workbench, and the workbench back to the farm", async ({ page }) => {
  await page.goto("/farm/");
  await page.getByTestId("to-workbench").click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.getByTestId("rail").locator('[data-place="farm"]').first().click();
  await expect(page).toHaveURL(/\/farm$/);
  await expect(page.getByTestId("farm").locator("canvas")).toBeVisible();
});
