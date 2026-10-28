// The title screen over the farm (src/farm/title): the menu by mouse and keys, 开始游戏 asking for the orchestrator's key
// first (the test server has none), 继续游戏 once there is a farm, and not showing again once left.

import { expect, test, defaultChannel } from "./fixtures";

// A new farm: no other file's lines on its server.
test.use({ farm: "title" });

test("a new farm: 继续游戏 is off, 开始游戏 asks for the key first, 设置 leaves, and the title does not come back", async ({ page }) => {
  await page.clock.install();
  await page.goto("/farm?tod=0.9");
  const title = page.getByRole("dialog", { name: "码农场物语 首页" });
  await expect(title.getByRole("heading", { name: "码农场物语" })).toBeVisible();
  await expect(title.getByRole("button", { name: "继续游戏" })).toBeDisabled();
  await expect(title.getByText("还没有农场可以继续：先开始游戏。")).toBeVisible();
  // The title fades in: moved through on the page's clock.
  await page.clock.runFor(800);
  await page.screenshot({ path: test.info().outputPath("title-night.png") });
  await page.keyboard.press("Enter");
  await expect(title.getByRole("status")).toContainText("先填钥匙");
  await title.getByRole("button", { name: "设置" }).click();
  await expect(page).toHaveURL(/\/settings\/deepseek$/);
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(title).toHaveCount(0);
});

test("with a farm, 继续游戏 is picked and Enter goes in", async ({ page, api }) => {
  await api.orchestrator.open();
  await api.channel.message.send({ id: await defaultChannel(api), text: "早", sendKey: "title-test-1" });
  await page.clock.install();
  await page.goto("/farm?tod=0.4");
  const title = page.getByRole("dialog", { name: "码农场物语 首页" });
  await expect(title.getByRole("button", { name: "继续游戏" })).toBeEnabled();
  await page.clock.runFor(800);
  await page.screenshot({ path: test.info().outputPath("title-day.png") });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(title).toHaveCount(0);
  await page.getByRole("button", { name: "手机" }).click();
  await page.getByRole("button", { name: /^展开田头/ }).click();
  await expect(page.getByRole("region", { name: "田头" }).getByText("早", { exact: true })).toBeVisible();
});
