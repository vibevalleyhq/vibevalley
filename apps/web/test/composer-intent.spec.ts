// The farm chat's sending, as far as the page wires it: the channel and helper picked go into the request, and a retry
// after a lost reply is the same message. Which changes make a new send and which keep it is composing.test.ts's.
import type { Locator, Page } from "@playwright/test";

import { defaultOrchestrator, type SayRequest, pathOf } from "@vibevalley/protocol";

import { expect, test } from "./fixtures";

test.use({ farm: "composer-intent" });

async function openFarmChat(page: Page) {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  // The farm chat is the farm phone's right screen: take the phone out and unfold it.
  await page.getByTestId("phone-button").click();
  await page.getByTestId("phone-chat").click();
  return page.getByTestId("farm-chat").getByTestId("composer-input");
}

async function chooseChannel(page: Page, id: string) {
  await page.getByTestId("channel-menu").click();
  await page.getByTestId("channels").locator(`[data-key="${id}"]`).click();
}

async function loseFirstReply(page: Page) {
  const sent: SayRequest[] = [];
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    sent.push(route.request().postDataJSON() as SayRequest);
    if (sent.length > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionclosed");
  });
  return sent;
}

async function sendAndLoseReply(page: Page, box: Locator, text: string) {
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByTestId("farm-chat").getByTestId("chat-problem")).toBeVisible();
  await expect(box).toHaveValue(text);
}

test("retrying the same words to the same channel reuses its accepted message", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "retry-same" });
  const words = "retry this once";
  const sent = await loseFirstReply(page);
  const box = await openFarmChat(page);
  await chooseChannel(page, channel);
  await sendAndLoseReply(page, box, words);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(sent.map((s) => s.id)).toEqual([channel, channel]);
  expect(sent[1]!.sendKey).toBe(sent[0]!.sendKey);
  expect((await api.channel.message.list({ id: channel })).filter((m) => m.text === words)).toHaveLength(1);
});

test("the helper picked on the farm goes with the next send", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "intent-helper" });
  const helpers = (await api.agent.list()).filter((a) => a.id !== defaultOrchestrator && a.enabled).slice(0, 2);
  expect(helpers).toHaveLength(2);
  const box = await openFarmChat(page);
  await chooseChannel(page, channel);
  const sent: SayRequest[] = [];
  page.on("request", (r) => r.url().endsWith(pathOf("channel.message.send")) && sent.push(r.postDataJSON() as SayRequest));
  const pick = async (id: string) => {
    const friends = page.getByTestId("friends");
    await friends.getByTestId("friends-toggle").click();
    const friend = friends.locator(`[data-testid="friend"][data-key="${id}"]`);
    await friend.getByTestId("friend-open").click();
    await friend.getByTestId("friend-pick").click();
    await expect(friend).toHaveAttribute("data-picked", "");
    await page.getByTestId("tool-hand").click();
  };
  for (const [i, helper] of helpers.entries()) {
    await pick(helper.id);
    await box.fill(`look at this ${i}`);
    await box.press("Enter");
    await expect(box).toHaveValue("");
  }
  expect(sent.map((s) => s.agent)).toEqual(helpers.map((a) => a.id));
});
