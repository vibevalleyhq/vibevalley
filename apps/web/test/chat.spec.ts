import { firstChannelName, type StateFrame, type VibeValleyApi } from "@vibevalley/protocol";
import { expect, settled, test } from "./fixtures";

// The state as the stream sends it: its first frame.
async function stateOf(baseURL: string) {
  const res = await fetch(`${baseURL}/api/v1/state`, { headers: { Accept: "text/event-stream" } });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (!buffer.includes("\n\n")) buffer += (await reader.read()).value ?? "";
  void reader.cancel();
  return (JSON.parse(buffer.slice(buffer.indexOf("data: ") + 6, buffer.indexOf("\n\n"))) as StateFrame).state;
}

async function newChannel(api: VibeValleyApi, name: string, description?: string) {
  return api.channel.create({ name, description });
}

test("the general shows with its empty words, the orchestrator resting", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: firstChannelName })).toBeVisible();
  const side = page.getByRole("complementary", { name: "频道和帮工" });
  await expect(side.getByRole("button", { name: firstChannelName })).toHaveAttribute("aria-current", "page");
  await expect(side.getByText("还没有在场的帮工")).toBeVisible();
  await expect(side.getByText("在歇着")).toBeVisible();
  await expect(page.getByRole("tab", { name: "聊天" })).toHaveAttribute("aria-selected", "true");
});

test("a sentence said shows in the list through the state stream", async ({ page, api }) => {
  const id = await newChannel(api, "说话");
  await page.goto(`/chat/${id}`);
  await expect(page.getByRole("heading", { name: "说话" })).toBeVisible();
  await expect(page.getByText("#说话 里还没人说话")).toBeVisible();
  const box = page.getByRole("textbox", { name: "发送消息至 #说话" });
  await box.fill("把测试跑一遍");
  await box.press("Enter");
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("把测试跑一遍")).toBeVisible();
  await expect(log.getByText("主人", { exact: true })).toBeVisible();
  await expect(box).toHaveValue("");
  // Without a model key the orchestrator answers that it has none; the page takes that as any answer.
  await expect(log.getByText("管家", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "说话" })).toBeVisible();
});

test("the direct channel with the orchestrator: listed apart, talked in alone, with no one to @", async ({ page }) => {
  await page.goto("/chat");
  const side = page.getByRole("complementary", { name: "频道和帮工" });
  await side.getByRole("region", { name: "私聊" }).getByRole("button", { name: "管家" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "管家" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "聊天" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  const box = page.getByRole("textbox", { name: "发送消息至 管家" });
  await box.click();
  await box.pressSequentially("单独问一句 @");
  await expect(page.getByRole("listbox", { name: "叫谁" })).toBeHidden();
  await expect(page.getByText("@ 叫人")).toHaveCount(0);
  await box.fill("单独问一句：地里怎么样");
  await box.press("Enter");
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("单独问一句：地里怎么样")).toBeVisible();
  // Without a model key the orchestrator answers that it has none, here and not in the default channel.
  await expect(log.getByText("管家", { exact: true })).toBeVisible({ timeout: 15_000 });
  await side.getByRole("button", { name: firstChannelName }).click();
  await expect(page.getByRole("log", { name: "消息" }).getByText("单独问一句：地里怎么样")).toHaveCount(0);
});

test("Shift+Enter starts a line and @ offers the orchestrator", async ({ page, api }) => {
  const id = await newChannel(api, "叫人");
  await page.goto(`/chat/${id}`);
  const box = page.getByRole("textbox", { name: "发送消息至 #叫人" });
  await box.click();
  await box.pressSequentially("看看 @");
  const menu = page.getByRole("listbox", { name: "叫谁" });
  await expect(menu.getByRole("option", { name: /@管家/ })).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("看看 @管家 ");
  await expect(menu).toBeHidden();
  await box.press("Shift+Enter");
  await expect(box).toHaveValue("看看 @管家 \n");
});

test("a channel made in the dialog is shown at its own address", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "创建频道" }).click();
  const dialog = page.getByRole("dialog", { name: "创建频道" });
  await dialog.getByLabel("名称").fill("clock-in");
  await dialog.getByLabel("描述").fill("打卡小程序");
  await dialog.getByRole("button", { name: "创建频道" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "clock-in" })).toBeVisible();
  await expect(page.locator("header").getByText("打卡小程序")).toBeVisible();
  await expect(page.getByRole("complementary").getByRole("button", { name: "clock-in" })).toHaveAttribute("aria-current", "page");
  const id = page.url().split("/").at(-1);
  const made = (await stateOf(new URL(page.url()).origin)).chat?.channels.find((c) => c.id === id);
  expect(made?.name).toBe("clock-in");
});

test("a refused name stays in the dialog with the reason", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "创建频道" }).click();
  const dialog = page.getByRole("dialog", { name: "创建频道" });
  await dialog.getByLabel("名称").fill("有 空格 的 名字");
  await dialog.getByRole("button", { name: "创建频道" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("p.text-berry")).not.toBeEmpty();
});

test("the channel's settings save its description", async ({ page, api }) => {
  const id = await newChannel(api, "设置");
  await page.goto(`/chat/${id}`);
  await page.getByRole("button", { name: "频道设置" }).click();
  const dialog = page.getByRole("dialog", { name: "# 设置 的设置" });
  await dialog.getByLabel("描述").fill("放设置的地方");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("header").getByText("放设置的地方")).toBeVisible();
  const saved = (await stateOf(new URL(page.url()).origin)).chat?.channels.find((c) => c.id === id);
  expect(saved?.description).toBe("放设置的地方");
});

test("search keeps the messages that contain it", async ({ page, api }) => {
  const id = await newChannel(api, "找");
  await api.channel.message.send({ id, text: "苹果要浇水" });
  await api.channel.message.send({ id, text: "香蕉该收了" });
  await page.goto(`/chat/${id}`);
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("香蕉该收了")).toBeVisible();
  await page.getByRole("button", { name: "找消息" }).click();
  await page.getByRole("textbox", { name: "在这个频道里找" }).fill("苹果");
  await expect(log.getByText("苹果要浇水")).toBeVisible();
  await expect(log.getByText("香蕉该收了")).toBeHidden();
  await expect(log.getByText("含「苹果」的消息")).toBeVisible();
  await page.getByRole("textbox", { name: "在这个频道里找" }).fill("西瓜");
  await expect(log.getByText("没有找到")).toBeVisible();
  await page.getByRole("textbox", { name: "在这个频道里找" }).press("Escape");
  await expect(log.getByText("香蕉该收了")).toBeVisible();
});

test("the recurrences tab turns a recurrence off and deletes it on the second press", async ({ page, api }) => {
  const id = await newChannel(api, "定时");
  await api.recurrence.create({ name: "跑测试", text: "跑一遍测试", channel: id, when: { kind: "once", at: Date.now() + 30 * 86400000 } });
  await page.goto(`/chat/${id}`);
  await page.getByRole("tab", { name: "任务" }).click();
  await expect(page.getByText("这个频道里还没有活")).toBeVisible();
  await page.getByRole("tab", { name: "定时" }).click();
  const card = page.getByLabel("定时「跑测试」");
  await expect(card.getByText("跑一遍测试")).toBeVisible();
  await card.getByRole("button", { name: "开着" }).click();
  await expect(card.getByRole("button", { name: "关着" })).toBeVisible();
  await card.getByRole("button", { name: "删掉定时「跑测试」" }).click();
  await card.getByRole("button", { name: "确定删？" }).click();
  await expect(page.getByText("这个频道还没有定时")).toBeVisible();
});

test("the chat page as it looks", async ({ page, api }) => {
  const id = await newChannel(api, "clock", "打卡小程序的活");
  await api.channel.update({ id, description: "打卡小程序的活", project: "clock-in" });
  await api.channel.message.send({ id, text: "帮我看看 @管家 打卡页为什么**白屏**" });
  await page.goto(`/chat/${id}`);
  await expect(page.getByRole("log", { name: "消息" }).getByText("管家", { exact: true })).toBeVisible({ timeout: 15_000 });
  // Shown, the orchestrator's answer is read: no count on the channel.
  await expect(page.getByRole("complementary").getByRole("button", { name: "clock", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("chat.png") });
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByRole("button", { name: "频道列表" }).click();
  await expect(page.getByRole("complementary", { name: "频道和帮工" })).toBeInViewport({ ratio: 1 });
  await settled(page);
  await page.screenshot({ path: test.info().outputPath("chat-narrow.png") });
});

test("scrolled up from the newest, a pill leads back down", async ({ page, api }) => {
  const id = await newChannel(api, "长聊");
  for (let i = 0; i < 40; i++) await api.channel.message.send({ id, text: `第 ${i} 句` });
  await page.goto(`/chat/${id}`);
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("第 39 句")).toBeVisible();
  await expect(page.getByRole("button", { name: "回到最新" })).toHaveCount(0);
  await log.evaluate((el) => el.scrollTo({ top: -2000 }));
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect(log.getByText("第 39 句")).toBeInViewport();
  await expect(page.getByRole("button", { name: "回到最新" })).toHaveCount(0);
});

test("/ offers the commands, and /issue writes an issue instead of saying the line", async ({ page, api }) => {
  const id = await newChannel(api, "命令");
  await page.goto(`/chat/${id}`);
  const box = page.getByRole("textbox", { name: "发送消息至 #命令" });
  await box.click();
  await box.pressSequentially("/is");
  const menu = page.getByRole("listbox", { name: "叫谁" });
  await expect(menu.getByText("/issue", { exact: true })).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("/issue ");
  await box.pressSequentially("给打卡页加分页");
  await box.press("Enter");
  await expect(page.getByText(/^记下了 #\d+$/)).toBeVisible();
  await expect(box).toHaveValue("");
  expect((await api.issue.list({})).some((i) => i.title === "给打卡页加分页")).toBe(true);
  expect((await api.channel.message.list({ id })).some((m) => m.text.includes("/issue"))).toBe(false);
  // A line that only looks like one is said.
  await box.fill("/usr/bin 在哪");
  await box.press("Enter");
  await expect(page.getByRole("log", { name: "消息" }).getByText("/usr/bin 在哪")).toBeVisible();
});
