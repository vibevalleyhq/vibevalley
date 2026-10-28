// The title screen over the farm (src/farm/title): the menu by mouse and keys, start asking for the orchestrator's key
// first (the test server has none), continue once there is a farm, and not showing again once left.

import { expect, test, defaultChannel } from "./fixtures";

// A new farm: no other file's lines on its server.
test.use({ farm: "title" });

const said = "morning";

test("a new farm: continue is off, start asks for the key first, settings leaves, and the title does not come back", async ({ page }) => {
  await page.clock.install();
  await page.goto("/farm?tod=0.9");
  const title = page.getByTestId("title");
  await expect(title.locator('[data-key="continue"]')).toBeDisabled();
  await expect(title.locator('[data-key="start"]')).toHaveAttribute("data-picked", "");
  // The title fades in: moved through on the page's clock.
  await page.clock.runFor(800);
  await page.keyboard.press("Enter");
  await expect(title.getByRole("status")).toBeVisible();
  await title.locator('[data-key="settings"]').click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(title).toHaveCount(0);
});

test("with a farm, continue is picked and Enter goes in", async ({ page, api }) => {
  await api.orchestrator.open();
  await api.channel.message.send({ id: await defaultChannel(api), text: said, sendKey: "title-test-1" });
  await page.clock.install();
  await page.goto("/farm?tod=0.4");
  const title = page.getByTestId("title");
  await expect(title.locator('[data-key="continue"]')).toBeEnabled();
  await page.clock.runFor(800);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(title.locator('[data-key="continue"]')).toHaveAttribute("data-picked", "");
  await page.keyboard.press("Enter");
  await expect(title).toHaveCount(0);
  await page.getByTestId("phone-button").click();
  await page.getByTestId("phone-chat").click();
  await expect(page.getByTestId("farm-chat").getByTestId("message").filter({ hasText: said })).toBeVisible();
});
