// 标为未读 as far as the page wires it: the read goes back at once, and a refused one gives the read back and says why.
// When a mark settles is features/channel/marks.test.ts's.
import { pathOf, type VibeValleyApi } from "@vibevalley/protocol";

import { expect, gate, test } from "./fixtures";

test.use({ farm: "chat-unread-rollback" });

const firstId = async (api: VibeValleyApi, channel: string) => {
  const [m] = await api.channel.message.list({ id: channel });
  if (!m) throw new Error("the channel has its message");
  return m;
};

test("a mark unread the server refuses gives the read back and says why in the error tone", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "unread-refused" });
  await api.channel.message.send({ id: channel, text: "first" });
  await api.channel.message.send({ id: channel, text: "second" });
  const first = await firstId(api, channel);
  const server = gate();
  await page.route(`**${pathOf("channel.markUnread")}`, async (route) => {
    await server.opened;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ _tag: "Refused", reason: "not now" }) });
  });
  await page.goto(`/chat/${channel}`);
  const messages = page.getByTestId("messages");
  const row = messages.locator(`[data-testid="message"][data-key="${first.id}"]`);
  await expect(row).toBeVisible();
  const read = await messages.getAttribute("data-read");
  expect(Number(read)).toBeGreaterThanOrEqual(first.number);
  await row.hover();
  await row.locator('[data-testid="message-tool"][data-key="more"]').click();
  await page.locator('[role="menuitem"][data-key="mark-unread"]').click();
  // On its way: the read is just before the message.
  await expect(messages).toHaveAttribute("data-read", String(first.number - 1));
  server.open();
  await expect(page.locator('[data-testid="toast"][data-tone="bad"]')).toBeVisible();
  await expect(messages).toHaveAttribute("data-read", read ?? "");
});
