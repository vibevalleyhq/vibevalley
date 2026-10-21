import { expect, test } from "./fixtures";

// The title screen shows on a machine's first visit; these tests start past it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("/ draws the farm on a canvas, without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const farm = page.getByRole("region", { name: "码农场物语的像素农场" });
  await expect(farm.locator("canvas")).toBeVisible();
  // At 1280 × 800 the village (384 × 256) is drawn three times over, with narrow bars.
  await expect(farm.locator("canvas")).toHaveCSS("width", "1152px");
  await expect(page.getByText(/在等农场|连不上农场/)).toHaveCount(0);
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/farm.png" });
  expect(errors).toEqual([]);
});

test("while the village's pictures come in, a bar says how far; drawn, it goes", async ({ page }) => {
  // Each picture a little late, so the bar is there to see.
  await page.route("**/pixel/*.png", async (route) => {
    await new Promise((r) => setTimeout(r, 150));
    await route.continue();
  });
  await page.goto("/");
  const bar = page.getByRole("progressbar", { name: "进村" });
  await expect(bar).toBeVisible();
  await expect(page.getByText(/搬东西进村 \d+\/\d+/)).toBeVisible();
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(bar).toHaveCount(0);
});

test("the farm links to the workbench, and the workbench back to the farm", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "工作台" }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.getByRole("navigation", { name: "工作台" }).getByRole("link", { name: "回农场" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "码农场物语的像素农场" }).locator("canvas")).toBeVisible();
});
