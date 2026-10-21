import { expect, test } from "./fixtures";

test("the manager's memory takes a note and forgets it", async ({ page }) => {
  await page.goto("/manager");
  await expect(page.getByRole("heading", { name: "管家" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "记性" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("替它记一条").fill("提交信息写中文");
  await page.getByRole("button", { name: "记下" }).click();
  const notes = page.getByRole("region", { name: "记下的" });
  await expect(notes.getByText("提交信息写中文")).toBeVisible();
  await expect(notes.getByText("你交代的")).toBeVisible();
  await notes.getByText("提交信息写中文").hover();
  await notes.getByRole("button", { name: "忘掉" }).click();
  await expect(notes.getByText("提交信息写中文")).toBeHidden();
});

test("the manager's trajectory shows what it was told, and a round it never heard cannot be marked wrong", async ({ page, api }) => {
  // Without the model's key the manager cannot start: the line is in its log, not in its conversation.
  await api.channel.say({ body: { text: "帮我看看打卡页" } });
  await page.goto("/manager/trajectory");
  const row = page.getByRole("button", { name: /^收到 .*帮我看看打卡页/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^\d+ 轮 · \d+ 步/)).toBeVisible();
  await row.hover();
  await page.getByRole("button", { name: "这一轮做错了" }).first().click();
  await page.getByLabel("这一轮应该怎样").fill("先问我是哪个项目");
  await page.getByRole("button", { name: "记下" }).click();
  await expect(page.getByRole("log", { name: "提示" })).toContainText("没进管家的对话");
  await page.getByLabel("搜索轨迹").fill("没有这种");
  await expect(page.getByText("没有对得上的步骤。")).toBeVisible();
});

test("the archive and the manager's voice", async ({ page }) => {
  await page.goto("/manager/archive");
  await expect(page.getByText("还没有：管家的对话还没长到要压缩。")).toBeVisible();
  await page.getByRole("tab", { name: "声音" }).click();
  await expect(page).toHaveURL(/\/manager\/voice$/);
  const greeting = page.getByLabel("开场白");
  const before = await greeting.inputValue();
  await greeting.fill("来啦，今天种什么？");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，下一通电话就用上。")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("开场白")).toHaveValue("来啦，今天种什么？");
  await page.getByLabel("开场白").fill(before);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("存好了，下一通电话就用上。")).toBeVisible();
});

test("the manager's page as it looks", async ({ page, api }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await api.channel.say({ body: { text: "看看今天地里怎么样" } });
  await page.goto("/manager/trajectory");
  await expect(page.getByRole("button", { name: /^收到 .*看看今天地里怎么样/ })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath("manager-trajectory.png") });
  await page.goto("/manager/voice");
  await expect(page.getByLabel("开场白")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("manager-voice.png") });
});
