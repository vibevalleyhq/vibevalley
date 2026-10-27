// What the chat does past saying and changing messages: channels managed from their settings and the sidebar, threads
// listed, a message's address, the box's drafts, emoji, keys and drops, files that play, the farm-wide search, and talking
// with a helper profile alone.

import type { Page } from "@playwright/test";
import type { Agent } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

const side = (page: Page) => page.getByRole("complementary", { name: "频道和帮工" });

test("a channel is renamed, grouped, quieted, archived and deleted from its settings", async ({ page, api }) => {
  const id = await api.channel.create({ name: "杂事" });
  await page.goto(`/chat/${id}`);
  await page.getByRole("button", { name: "频道设置" }).click();
  const dialog = page.getByRole("dialog", { name: "# 杂事 的设置" });
  await dialog.getByRole("textbox", { name: "名称" }).fill("琐事");
  await dialog.getByRole("combobox", { name: /^分组/ }).fill("日常");
  await dialog.getByRole("button", { name: "不提醒", exact: true }).click();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("heading", { name: "琐事" })).toBeVisible();
  const group = side(page).getByRole("region", { name: "日常" });
  await expect(group.getByRole("button", { name: /^琐事/ })).toBeVisible();
  await expect(group.getByText("不提醒")).toBeVisible();

  await page.getByRole("button", { name: "频道设置" }).click();
  await page.getByRole("dialog", { name: "# 琐事 的设置" }).getByRole("button", { name: "归档" }).click();
  await expect(side(page).getByRole("region", { name: "日常" })).toHaveCount(0);
  const archived = side(page).getByRole("region", { name: "已归档" });
  await archived.getByRole("button", { name: /已归档/ }).click();
  await expect(archived.getByRole("button", { name: /^琐事/ })).toBeVisible();

  await page.getByRole("button", { name: "频道设置" }).click();
  const again = page.getByRole("dialog", { name: "# 琐事 的设置" });
  await again.getByRole("button", { name: "删除频道" }).click();
  await expect(again.getByText("删除以后：")).toBeVisible();
  await again.getByRole("button", { name: "确定删除" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(side(page).getByRole("button", { name: /^琐事/ })).toHaveCount(0);
});

test("a channel dropped on another is placed before it", async ({ page, api }) => {
  const first = await api.channel.create({ name: "甲" });
  await api.channel.create({ name: "乙" });
  await api.channel.create({ name: "丙" });
  await page.goto(`/chat/${first}`);
  const rows = side(page).getByRole("region", { name: "频道" });
  await rows.getByRole("button", { name: "丙", exact: true }).dragTo(rows.getByRole("button", { name: "甲", exact: true }));
  // The default channel stays first; the dropped one is next.
  const order = () => side(page).getByRole("region", { name: "频道" }).locator("button[draggable]");
  await expect(order().nth(1)).toHaveText("#丙");
  await page.reload();
  await expect(order().nth(1)).toHaveText("#丙");
});

test("a thread is listed under its channel, renamed and archived there", async ({ page, api }) => {
  const id = await api.channel.create({ name: "串们" });
  await api.channel.message.send({ id, text: "这件事开个串" });
  const [said] = await api.channel.message.list({ id });
  await api.channel.thread.create({ id: said!.id });
  await page.goto(`/chat/${id}`);
  await page.getByRole("button", { name: "串", exact: true }).click();
  const list = page.getByRole("dialog", { name: "这个频道的串" });
  await expect(list.getByText("这件事开个串")).toBeVisible();
  await list.getByRole("button", { name: /^给「这件事开个串」改名$/ }).click();
  const rename = list.getByRole("textbox", { name: /改名/ });
  await rename.fill("开串的事");
  await rename.press("Enter");
  await expect(list.getByText("开串的事")).toBeVisible();
  await list.getByRole("button", { name: "归档「开串的事」" }).click();
  await expect(list.getByText("这个频道还没有串")).toBeVisible();
  await list.getByRole("button", { name: /已归档的串/ }).click();
  await expect(list.getByRole("button", { name: "取消归档「开串的事」" })).toBeVisible();
});

test("a message's address scrolls to it and lights it up, from the pins, a reply's quote and the farm's search", async ({ page, api }) => {
  const id = await api.channel.create({ name: "长谈" });
  for (let i = 1; i <= 70; i++) await api.channel.message.send({ id, text: `第 ${i} 句` });
  // The orchestrator answers too (it has no key): the owner's lines are not numbered 1 to 70.
  const all = [...(await api.channel.message.list({ id, before: 1000, limit: 100 })), ...(await api.channel.message.list({ id, before: 40, limit: 100 }))];
  const numberOf = (text: string) => all.find((m) => m.text === text)!.number;
  const first = all.find((m) => m.text === "第 1 句")!;
  await api.channel.pin.toggle({ id: first.id });
  await api.channel.message.send({ id, text: "回到开头", replyTo: numberOf("第 2 句") });

  await page.goto(`/chat/${id}`);
  const log = page.getByRole("log", { name: "消息" });
  const row = (n: number) => log.locator(`[data-number="${n}"]`);
  await expect(log.getByText("回到开头")).toBeVisible();
  await page.getByRole("button", { name: "置顶的消息" }).click();
  await page.getByRole("dialog", { name: "置顶" }).getByText("第 1 句").click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}\\?m=${first.number}$`));
  await expect(row(first.number)).toBeInViewport();
  await expect(row(first.number)).toHaveClass(/bg-wheat/);

  await page.goto(`/chat/${id}`);
  await log.getByRole("button", { name: /第 2 句/ }).click();
  await expect(page).toHaveURL(new RegExp(`\\?m=${numberOf("第 2 句")}$`));
  await expect(row(numberOf("第 2 句"))).toBeInViewport();

  await side(page).getByRole("button", { name: "搜全农场" }).click();
  const search = page.getByRole("dialog", { name: "搜全农场" });
  await search.getByRole("textbox", { name: "搜全农场" }).fill("in:#长谈 第 33 句");
  await search.getByRole("listitem").filter({ hasText: "第 33 句" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?m=${numberOf("第 33 句")}$`));
  await expect(row(numberOf("第 33 句"))).toBeInViewport();
});

test("the box keeps its draft across a reload; ↑ edits the last message, Esc lets go of a reply, emoji go in at the caret", async ({ page, api }) => {
  const id = await api.channel.create({ name: "输入" });
  await api.channel.message.send({ id, text: "原来的话" });
  await page.goto(`/chat/${id}`);
  const box = page.getByRole("textbox", { name: "发送消息至 #输入" });
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("原来的话")).toBeVisible();

  await box.click();
  await box.press("ArrowUp");
  const editing = log.getByRole("textbox", { name: "改" });
  await editing.fill("改过的话");
  await editing.press("Enter");
  await expect(log.getByText("改过的话")).toBeVisible();

  await log.getByText("改过的话").hover();
  await page.getByRole("toolbar", { name: "这条消息能做的" }).getByRole("button", { name: "回复" }).click();
  await expect(page.getByText("回复 主人：改过的话")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByText("回复 主人：改过的话")).toHaveCount(0);

  await box.fill("还没写完");
  await page.getByRole("button", { name: "表情" }).click();
  await page.getByRole("dialog", { name: "表情" }).getByRole("button", { name: "🎉" }).click();
  await expect(box).toHaveValue("还没写完🎉");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "发送消息至 #输入" })).toHaveValue("还没写完🎉");
});

test("a file dropped on the channel goes up; a video plays in place and a PDF opens in its own tab", async ({ page, api }) => {
  const id = await api.channel.create({ name: "媒体" });
  await page.goto(`/chat/${id}`);
  const drop = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["fake video"], "片子.mp4", { type: "video/mp4" }));
    dt.items.add(new File(["%PDF-1.4"], "说明.pdf", { type: "application/pdf" }));
    return dt;
  });
  const log = page.getByRole("log", { name: "消息" });
  await log.dispatchEvent("dragover", { dataTransfer: drop });
  await expect(page.getByText("松手就传到这里")).toBeVisible();
  await log.dispatchEvent("drop", { dataTransfer: drop });
  await expect(page.getByRole("button", { name: "去掉 片子.mp4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "去掉 说明.pdf" })).toBeVisible();
  await page.getByRole("textbox", { name: "发送消息至 #媒体" }).press("Enter");
  await expect(log.locator("video")).toHaveAttribute("aria-label", "片子.mp4");
  await expect(log.getByRole("link", { name: /说明\.pdf/ })).toContainText("在新标签页里看");

  await log.locator("video").hover();
  await page.getByRole("toolbar", { name: "这条消息能做的" }).getByRole("button", { name: "改" }).click();
  await log.getByRole("button", { name: "去掉 说明.pdf" }).click();
  await log.getByRole("textbox", { name: "改" }).press("Enter");
  await expect(log.getByRole("link", { name: /说明\.pdf/ })).toHaveCount(0);
  await expect(log.locator("video")).toHaveCount(1);
});

const helper: Agent = {
  id: "",
  name: "阿狐",
  role: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};

test("the owner talks with a helper profile alone, and its answer can be marked unread", async ({ page, api }) => {
  await api.agent.create(helper);
  await api.project.create({ name: "talk-farm" });
  await page.goto("/chat");
  const directs = side(page).getByRole("region", { name: "私聊" });
  await directs.getByRole("button", { name: "开一个私聊" }).click();
  await page.getByRole("menu", { name: "和谁私聊" }).getByRole("menuitem", { name: "阿狐" }).click();
  await expect(page.getByRole("heading", { name: "阿狐" })).toBeVisible();
  const box = page.getByRole("textbox", { name: "发送消息至 阿狐" });
  await box.fill("仓库里有什么？");
  await box.press("Enter");
  const log = page.getByRole("log", { name: "消息" });
  const answer = log.getByText("做完了", { exact: true });
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(directs.getByRole("button", { name: /阿狐/ })).toBeVisible();

  await answer.hover();
  const tools = page.getByRole("toolbar", { name: "这条消息能做的" });
  await tools.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "从这里标成未读" }).click();
  await side(page).getByRole("region", { name: "频道" }).locator("button[draggable]").first().click();
  await expect(directs.getByRole("button", { name: /阿狐/ })).toContainText(/\d/);
  await page.screenshot({ path: test.info().outputPath("chat-direct.png") });
});
