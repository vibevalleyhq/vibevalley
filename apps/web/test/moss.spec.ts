import { expect, test } from "./fixtures";

// The playground's line goes through the server, which holds the key: with none saved, the call says so and stays idle.
test("the MOSS Live playground says why it cannot talk while no key is saved", async ({ page }) => {
  await page.goto("/settings/moss");
  await expect(page.getByRole("group", { name: "线路质量" })).toBeVisible();
  await page.getByRole("button", { name: "开始说话" }).click();
  await expect(page.getByText("还没填 MOSS Live 的 API Key")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始说话" })).toBeVisible();
  await expect(page.getByRole("list", { name: "线路上的消息" })).toBeVisible();
});
