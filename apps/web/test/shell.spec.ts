import { expect, test } from "./fixtures";

const places = ["chat", "issues", "docs", "agents", "runtimes", "projects", "catalog", "settings"];

test("the rail lists every place, the farm at the top, and marks where you are", async ({ page }) => {
  await page.goto("/issues");
  const rail = page.getByTestId("rail");
  await expect(rail.getByTestId("link")).toHaveAttribute("data-state", "open");
  await expect(rail.locator('[data-place="farm"]').first()).toHaveAttribute("href", "/farm");
  for (const place of places) await expect(rail.locator(`[data-place="${place}"]`)).toBeVisible();
  await expect(rail.locator('[data-place="issues"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("desk")).toHaveAttribute("data-place", "issues");
  // The server is the worker's: an earlier test may have left the orchestrator at work.
  await expect(page.getByTestId("desk-status")).toHaveAttribute("data-state", /^(live|off)$/);
});

test("every place opens under its own head, and the chat has none", async ({ page }) => {
  await page.goto("/issues");
  const rail = page.getByTestId("rail");
  for (const place of ["docs", "agents", "runtimes", "projects", "catalog"]) {
    await rail.locator(`[data-place="${place}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/${place}$`));
    await expect(page.getByTestId("desk")).toHaveAttribute("data-place", place);
  }
  await rail.locator('[data-place="chat"]').click();
  await expect(rail.locator('[data-place="chat"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("desk")).toHaveCount(0);
});
