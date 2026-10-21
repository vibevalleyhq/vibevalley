import { expect, test } from "./fixtures";

test("the runtimes list what oar found, and a runtime's settings are saved and put back", async ({ page }) => {
  await page.goto("/runtimes");
  const list = page.getByRole("region", { name: "农具列表" });
  await expect(list.getByRole("link").first()).toBeVisible();
  await list.getByRole("link", { name: /^Pi/ }).click();
  await expect(page).toHaveURL(/\/runtimes\/pi$/);
  await expect(page.getByRole("heading", { name: "Pi", exact: true })).toBeVisible();
  await expect(page.getByText("能做什么")).toBeVisible();
  await expect(page.getByText("oar 提供的查询")).toBeVisible();
  const most = page.getByLabel("最多同时干活");
  await most.fill("2");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: "放弃" })).toBeHidden();
  await page.reload();
  await expect(page.getByLabel("最多同时干活")).toHaveValue("2");
  await page.getByLabel("最多同时干活").fill("");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: "放弃" })).toBeHidden();
  await page.getByRole("link", { name: "用它捏一个新 agent →" }).click();
  await expect(page).toHaveURL(/\/agents\/new\?runtime=pi$/);
  await expect(page.getByLabel("名字", { exact: true })).toHaveValue("新的 Pi");
});

test("农具 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/runtimes/pi");
  await expect(page.getByText("能做什么")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("runtimes.png"), fullPage: true });
});
