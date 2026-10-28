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

test("? off a text field opens every shortcut, by where it works; in a field it is a question mark", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcuts");
  await expect(sheet.locator('[data-testid="shortcut-place"][data-key="everywhere"]')).toBeVisible();
  await expect(sheet.locator('[data-testid="shortcut-place"][data-key="farm"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.getByRole("textbox").first().click();
  await page.keyboard.press("?");
  await expect(sheet).toBeHidden();
});
