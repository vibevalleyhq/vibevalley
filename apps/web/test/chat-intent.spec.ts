// A line said in the workbench, as far as the page wires it: it shows at once and once after, a failed one waits in its
// channel with its key while the owner is elsewhere, and a line said while the state stream is down goes once it is back.
// When a line settles is base/intent.test.ts's and features/channel/composing.test.ts's.
import type { Page } from "@playwright/test";

import { pathOf, readStream, type SayRequest, type StateFrame, statePath, type VibeValleyApi } from "@vibevalley/protocol";

import { composerOn, expect, gate, test } from "./fixtures";

test.use({ farm: "chat-intent" });

const sends = (page: Page) => {
  const sent: SayRequest[] = [];
  page.on("request", (r) => r.url().endsWith(pathOf("channel.message.send")) && sent.push(r.postDataJSON()));
  return sent;
};

const said = async (api: VibeValleyApi, channel: string, text: string) =>
  (await api.channel.message.list({ id: channel })).filter((m) => m.text === text).length;

test("a line shows at once as sending while the server takes its time, and once after", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "slow-server" });
  const server = gate();
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    await server.opened;
    await route.continue();
  });
  await page.goto(`/chat/${channel}`);
  const box = await composerOn(page, channel);
  await box.fill("hold on a moment");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(page.locator('[data-testid="pending-line"][data-state="sending"]')).toHaveCount(1);
  server.open();
  await expect(page.getByTestId("pending-line")).toHaveCount(0);
  await expect(page.locator('[data-testid="message"][data-from-kind="owner"]').filter({ hasText: "hold on a moment" })).toHaveCount(1);
  expect(await said(api, channel, "hold on a moment")).toBe(1);
});

test("a line that never reached the server waits failed in its channel, and sent again after leaving it is the same line", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "never-reached" });
  const other = await api.channel.create({ name: "somewhere-else" });
  let first = true;
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.abort("connectionfailed");
  });
  const sent = sends(page);
  await page.goto(`/chat/${channel}`);
  const box = await composerOn(page, channel);
  await box.fill("say this once");
  await box.press("Enter");
  await expect(page.locator('[data-testid="pending-line"][data-state="failed"]')).toHaveCount(1);
  const side = page.getByTestId("channels-side");
  await side.locator(`[data-testid="channel-row"][data-key="${other}"]`).click();
  await composerOn(page, other);
  await expect(page.getByTestId("pending-line")).toHaveCount(0);
  await side.locator(`[data-testid="channel-row"][data-key="${channel}"]`).click();
  await composerOn(page, channel);
  await page.locator('[data-testid="pending-line"][data-state="failed"]').getByTestId("pending-retry").click();
  await expect(page.getByTestId("pending-line")).toHaveCount(0);
  await expect(page.locator('[data-testid="message"][data-from-kind="owner"]').filter({ hasText: "say this once" })).toHaveCount(1);
  expect(sent.map((s) => s.sendKey)).toEqual([sent[0]?.sendKey, sent[0]?.sendKey]);
  expect(await said(api, channel, "say this once")).toBe(1);
});

test("a line said while the state stream is down waits, and goes once when it is back", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "while-down" });
  // One frame, then the stream ends: the page has the farm, and the link is lost until the test lets it back.
  const abort = new AbortController();
  const frame = await new Promise<StateFrame>((resolve, reject) => {
    readStream(api.base, statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e: unknown) => abort.signal.aborted || reject(e));
  });
  let down = true;
  let once = true;
  await page.route(`**${statePath}`, async (route) => {
    if (!down) return route.continue();
    if (!once) return route.abort("connectionrefused");
    once = false;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(frame)}\n\n` });
  });
  const sent = sends(page);
  await page.goto(`/chat/${channel}`);
  const box = await composerOn(page, channel);
  await expect(page.getByTestId("link")).toHaveAttribute("data-state", "lost");
  await box.fill("after the outage");
  await box.press("Enter");
  await expect(page.locator('[data-testid="pending-line"][data-state="sending"]')).toHaveCount(1);
  expect(sent).toHaveLength(0);
  down = false;
  await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("pending-line")).toHaveCount(0);
  await expect(page.locator('[data-testid="message"][data-from-kind="owner"]').filter({ hasText: "after the outage" })).toHaveCount(1);
  expect(sent).toHaveLength(1);
  expect(await said(api, channel, "after the outage")).toBe(1);
});
