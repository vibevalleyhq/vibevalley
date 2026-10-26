import { expect, settled, test } from "./fixtures";

test("a helper is made, edited, turned off and deleted", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("link", { name: "管家" })).toBeVisible();
  await page.getByRole("link", { name: "捏一个新帮工" }).first().click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByText("新的", { exact: true })).toBeVisible();
  await page.getByLabel("名字", { exact: true }).fill("测试员小狐");
  await page.getByLabel("职责").fill("跑测试、写测试");
  await page.getByLabel("适合的活").fill("测试");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "小狐狸", exact: true }).click();
  await page.getByRole("button", { name: "雨衣", exact: true }).click();
  await expect(page.getByText("小狐狸 · 雨衣")).toBeVisible();
  await page.getByRole("button", { name: "干活" }).click();
  await page.getByRole("tab", { name: "人设" }).click();
  await page.getByLabel("人设").fill("先写测试再改代码。");
  await page.getByRole("tab", { name: "环境" }).click();
  await page.getByLabel("默认项目").fill("clock-in");
  await page.getByLabel("变量名").fill("CI");
  await page.getByLabel("变量的值").fill("1");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.getByLabel("CI 的值")).toHaveValue("1");
  // Typed key by key: the row stays, so the field keeps its focus.
  await page.getByLabel("CI 的值").press("End");
  await page.getByLabel("CI 的值").pressSequentially("23");
  await expect(page.getByLabel("CI 的值")).toHaveValue("123");
  await page.getByLabel("CI 的值").fill("1");
  await page.getByRole("button", { name: "捏好了，保存" }).click();
  await expect(page).toHaveURL(/\/agents\/(?!new).+/);
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.getByRole("tab", { name: "记性" })).toBeVisible();

  await page.getByLabel("职责").fill("只跑测试");
  await expect(page.getByText("没保存")).toBeVisible();
  await page.getByRole("button", { name: "放弃改动" }).click();
  await expect(page.getByLabel("职责")).toHaveValue("跑测试、写测试");

  await page.getByRole("link", { name: "← 全部帮工" }).click();
  const card = page.getByRole("link", { name: "测试员小狐" });
  await expect(card).toContainText("跑测试、写测试");
  await expect(card).toContainText("测试");
  await card.hover();
  await page.getByRole("button", { name: "停用 测试员小狐" }).click();
  await expect(page.getByRole("button", { name: "启用 测试员小狐" })).toBeAttached();

  await card.click();
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("删掉 测试员小狐？")).toBeVisible();
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("link", { name: "测试员小狐" })).toBeHidden();
});

test("a profile that does not exist says so", async ({ page }) => {
  await page.goto("/agents/nobody-here");
  await expect(page.getByText("没有这个帮工。")).toBeVisible();
});

test("帮工 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.goto("/agents");
  await expect(page.getByRole("link", { name: "管家" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("agents.png") });
  await page.goto("/agents/new");
  await expect(page.getByText("新的", { exact: true })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: test.info().outputPath("agent-new.png") });
});
