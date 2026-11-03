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
  const template = (await api.agent.list()).find((agent) => agent.role === "worker" && agent.runtime === "pi");
  if (!template) throw new Error("the test farm has a pi helper");
  const helper = await api.agent.create({ ...template, id: "", name: "read receipt", effort: "" });
  const channel = await api.channel.direct.create({ agent: helper.id });
  await api.channel.message.send({ id: channel, text: "first" });
  await expect.poll(async () => (await api.channel.message.list({ id: channel })).some((message) => message.fromKind === "session")).toBe(true);
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
  const latest = Math.max(...(await api.channel.message.list({ id: channel })).map((message) => message.number));
  await expect(messages).toHaveAttribute("data-read", String(latest));
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
  const readingAgain = page.waitForResponse((response) => response.url().endsWith(pathOf("channel.markRead")) && response.ok());
  await api.channel.markUnread({ id: channel, number: first.number });
  await readingAgain;
  await expect(messages).toHaveAttribute("data-read", read ?? "");
});
