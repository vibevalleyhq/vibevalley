// What the voice parts show on a test server: no MOSS key and no address of its own, so dictation waits to be set up. A call without
// Agora's keys is farm-phone.spec.ts's.

import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("dictation waits for a transcriber to be set", async ({ page }) => {
  await page.goto("/chat");
  const dictate = page.getByTestId("composer").getByTestId("dictate");
  await expect(dictate).toHaveAttribute("data-state", "unset");
  await expect(dictate).toBeDisabled();
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
