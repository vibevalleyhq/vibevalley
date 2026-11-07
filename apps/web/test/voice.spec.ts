import { expect, test } from "./fixtures";

test("dictation waits for a transcriber to be set, and its key opens where one is set", async ({ page }) => {
  await page.goto("/chat");
  const dictate = page.getByTestId("composer").getByTestId("dictate");
  await expect(dictate).toHaveAttribute("data-state", "unset");
  await dictate.click();
  await expect(page).toHaveURL(/\/settings\/dictation$/u);
});

test("` opens the debug console over the farm, and its level-up shows the banner", async ({ page }) => {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await page.keyboard.press("`");
  const debug = page.getByTestId("debug");
  await expect(debug).toBeVisible();
  await debug.getByTestId("debug-level-up").click();
  await expect(page.getByTestId("level-up")).toHaveAttribute("data-level", /^\d+$/u);
  const stopped = debug.locator('[data-key="0"]');
  await stopped.click();
  await expect(stopped).toHaveAttribute("aria-pressed", "true");
  await expect(debug.getByTestId("debug-frame").first()).toBeVisible();
  await debug.getByTestId("debug-close").click();
  await expect(debug).toBeHidden();
});
