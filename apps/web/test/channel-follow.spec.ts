// What is said in a channel reaches every page showing it through the page's WebSocket (/api/v1/rpc), each
// line once; the sender's own line takes the place of its sending copy.

import { composerOn, expect, test } from "./fixtures";

test.use({ farm: "channel-follow" });

const mine = "can both sides see this";
const elsewhere = "said from elsewhere";

test("two pages on one channel each get a line said in it, once", async ({ page, context, api }) => {
  const id = await api.channel.create({ name: "both-sides" });
  const other = await context.newPage();
  await Promise.all([page.goto(`/chat/${id}`), other.goto(`/chat/${id}`)]);
  for (const p of [page, other]) await expect(p.getByTestId("messages-empty")).toBeVisible();

  const box = await composerOn(page, id);
  await box.fill(mine);
  await box.press("Enter");
  for (const p of [page, other]) {
    const messages = p.getByTestId("messages");
    await expect(messages.getByTestId("message").filter({ hasText: mine })).toHaveCount(1);
    // Without a model key the orchestrator answers that it has none: a second line, said by the server.
    await expect(messages.locator('[data-testid="message"][data-from-kind="orchestrator"]').first()).toBeVisible({ timeout: 15_000 });
  }

  // Said from elsewhere (the command line, a chat app), it reaches both too.
  await api.channel.message.send({ id, text: elsewhere });
  for (const p of [page, other]) await expect(p.getByTestId("messages").getByTestId("message").filter({ hasText: elsewhere })).toHaveCount(1);
});
