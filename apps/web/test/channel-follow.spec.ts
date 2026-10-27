// What is said in a channel reaches every page showing it through the page's WebSocket (/api/v1/rpc), each
// line once; the sender's own line takes the place of its 「发送中」 copy.

import { expect, test } from "./fixtures";

test.use({ farm: "channel-follow" });

test("two pages on one channel each get a line said in it, once", async ({ page, context, api }) => {
  const id = await api.channel.create({ name: "两边" });
  const other = await context.newPage();
  await Promise.all([page.goto(`/chat/${id}`), other.goto(`/chat/${id}`)]);
  for (const p of [page, other]) await expect(p.getByText("#两边 里还没人说话")).toBeVisible();

  const box = page.getByRole("textbox", { name: "发送消息至 #两边" });
  await box.fill("两边都看得到吗");
  await box.press("Enter");
  for (const p of [page, other]) {
    const log = p.getByRole("log", { name: "消息" });
    await expect(log.getByText("两边都看得到吗")).toHaveCount(1);
    // Without a model key the orchestrator answers that it has none: a second line, said by the server.
    await expect(log.getByText("管家", { exact: true })).toBeVisible({ timeout: 15_000 });
  }

  // Said from elsewhere (the command line, a chat app), it reaches both too.
  await api.channel.message.send({ id, text: "从别处说一句" });
  for (const p of [page, other]) await expect(p.getByRole("log", { name: "消息" }).getByText("从别处说一句")).toHaveCount(1);
});
