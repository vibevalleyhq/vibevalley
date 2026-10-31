// A search answered out of order: only the answer to the newest words is shown. Which answer is kept is
// state/latest.test.ts's; this checks the page is wired to it.
import type { Request } from "@playwright/test";

import { pathOf, type MessageSearch } from "@vibevalley/protocol";

import { expect, gate, settled, test } from "./fixtures";

test.use({ farm: "chat-search-order" });

const wordsOf = (r: Request): string => {
  const body: MessageSearch = r.postDataJSON();
  return body.text;
};

test("an answer to older words that comes after the newer one's does not replace it", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "search-order" });
  await api.channel.message.send({ id: channel, text: "water the apples" });
  await api.channel.message.send({ id: channel, text: "harvest the bananas" });
  const all = await api.channel.message.list({ id: channel });
  const apples = all.find((m) => m.text.includes("apples"));
  const bananas = all.find((m) => m.text.includes("bananas"));
  if (!apples || !bananas) throw new Error("both messages are there");
  const first = gate();
  const asked: string[] = [];
  await page.route(`**${pathOf("channel.message.search")}`, async (route) => {
    asked.push(wordsOf(route.request()));
    // The first search's answer waits until the second has been shown.
    if (asked.length === 1) await first.opened;
    await route.continue();
  });
  await page.goto(`/chat/${channel}`);
  const messages = page.getByTestId("messages");
  await expect(messages.locator(`[data-testid="message"][data-key="${bananas.id}"]`)).toBeVisible();
  await page.getByTestId("message-search-toggle").click();
  const search = page.getByTestId("message-search");
  await search.fill("apples");
  await expect.poll(() => asked.length).toBe(1);
  await search.fill("bananas");
  await expect(messages.locator(`[data-testid="message"][data-key="${bananas.id}"]`)).toBeVisible();
  await expect(messages.locator(`[data-testid="message"][data-key="${apples.id}"]`)).toBeHidden();
  const late = page.waitForResponse((r) => r.url().endsWith(pathOf("channel.message.search")) && wordsOf(r.request()) === "apples");
  first.open();
  await late;
  await settled(page);
  await expect(messages.locator(`[data-testid="message"][data-key="${apples.id}"]`)).toBeHidden();
  await expect(messages.locator(`[data-testid="message"][data-key="${bananas.id}"]`)).toBeVisible();
});
