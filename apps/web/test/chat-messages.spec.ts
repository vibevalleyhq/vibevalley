import { attachmentPath } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

// The smallest PNG there is: one transparent pixel.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("a message is answered, changed, reacted to, pinned and deleted from the tools over it", async ({ page, api }) => {
  const id = await api.channel.create({ name: "说话" });
  await api.channel.message.send({ id, text: "苹果要浇水" });
  await page.goto(`/chat/${id}`);
  const log = page.getByRole("log", { name: "消息" });
  // By its paragraph: a reply quotes the same words.
  const first = log.locator("p", { hasText: /^苹果要(多)?浇水$/ });
  await expect(first).toBeVisible();
  await expect(log.getByRole("button", { name: /👀/ })).toBeVisible();
  const tools = page.getByRole("toolbar", { name: "这条消息能做的" });

  await first.hover();
  await tools.getByRole("button", { name: "回复" }).click();
  await expect(page.getByText("回复 主人：苹果要浇水")).toBeVisible();
  const box = page.getByRole("textbox", { name: "发送消息至 #说话" });
  await box.fill("好的，我来");
  await box.press("Enter");
  const answer = log.locator("p", { hasText: "好的，我来" });
  await expect(answer).toBeVisible();
  await expect(page.getByText("回复 主人：苹果要浇水")).toHaveCount(0);

  await first.hover();
  await tools.getByRole("button", { name: "改" }).click();
  const editing = log.getByRole("textbox", { name: "改" });
  await editing.fill("苹果要多浇水");
  await editing.press("Enter");
  await expect(log.getByText("苹果要多浇水")).toHaveCount(2);
  await expect(log.getByText("（已编辑）")).toBeVisible();

  await answer.hover();
  await tools.getByRole("button", { name: "回应" }).click();
  await tools.getByRole("button", { name: "🎉" }).click();
  await expect(log.getByRole("button", { name: /🎉\s*1/ })).toHaveAttribute("aria-pressed", "true");

  await answer.hover();
  await tools.getByRole("button", { name: "置顶" }).click();
  await page.getByRole("button", { name: "置顶的消息" }).click();
  await expect(page.getByRole("dialog", { name: "置顶" }).getByText("好的，我来")).toBeVisible();
  await page.getByRole("button", { name: "置顶的消息" }).click();

  await page.getByRole("button", { name: "成员" }).click();
  const members = page.getByRole("complementary", { name: "成员" });
  await expect(members.getByText("主人")).toBeVisible();
  await expect(members.getByText("管家")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("chat-messages.png") });

  await answer.hover();
  await tools.getByRole("button", { name: "删掉" }).click();
  await tools.getByRole("button", { name: "再点一次删掉" }).click();
  await expect(log.getByText("这条消息已删除")).toBeVisible();
  await expect(log.getByText("好的，我来")).toHaveCount(0);
});

test("a change made elsewhere reaches the page as it happens", async ({ page, api }) => {
  const id = await api.channel.create({ name: "别处" });
  await api.channel.message.send({ id, text: "看看这个" });
  await page.goto(`/chat/${id}`);
  const log = page.getByRole("log", { name: "消息" });
  await expect(log.getByText("看看这个")).toBeVisible();
  const [said] = await api.channel.message.list({ id });
  await api.channel.reaction.toggle({ id: said!.id, emoji: "👍" });
  await expect(log.getByRole("button", { name: /👍\s*1/ })).toBeVisible();
  await api.channel.message.update({ id: said!.id, text: "看看这个吧" });
  await expect(log.getByText("看看这个吧")).toBeVisible();
});

test("a picture picked for a message shows in it and opens at its own address", async ({ page, api, server }) => {
  const id = await api.channel.create({ name: "贴图" });
  await page.goto(`/chat/${id}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "截图.png", mimeType: "image/png", buffer: pixel });
  await expect(page.getByRole("button", { name: "去掉 截图.png" })).toBeVisible();
  await page.getByRole("textbox", { name: "发送消息至 #贴图" }).press("Enter");
  const image = page.getByRole("log", { name: "消息" }).getByRole("img", { name: "截图.png" });
  await expect(image).toBeVisible();
  const src = await image.getAttribute("src");
  const [said] = await api.channel.message.list({ id });
  expect(src).toBe(attachmentPath(said!.attachments![0]!.id));
  const res = await fetch(server.url + src);
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
});
