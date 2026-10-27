import type { Locator, Page } from "@playwright/test";
import { orchestratorAgent, type SayRequest, pathOf } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.use({ farm: "composer-intent" });

async function openFarmChat(page: Page) {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  // 田头 is the farm phone's right screen: take the phone out and unfold it.
  await page.getByRole("button", { name: "手机" }).click();
  await page.getByRole("button", { name: /^展开田头/ }).click();
  return page.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
}

async function chooseChannel(page: Page, name: string) {
  await page.getByRole("button", { name: /^频道：/ }).click();
  await page
    .getByRole("dialog", { name: "频道", exact: true })
    .getByRole("button", { name: `#${name}`, exact: true })
    .click();
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
  await expect(page.getByText(/没发出去：/)).toBeVisible();
  await expect(box).toHaveValue(text);
}

test("retrying the same words to the same channel reuses its accepted message", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "retry-same" });
  const sent = await loseFirstReply(page);
  const box = await openFarmChat(page);
  await chooseChannel(page, "retry-same");
  await sendAndLoseReply(page, box, "这句话重试一次");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(sent).toHaveLength(2);
  expect(sent[1]!.sendKey).toBe(sent[0]!.sendKey);
  expect((await api.channel.message.list({ id: channel })).filter((m) => m.text === "这句话重试一次")).toHaveLength(1);
});

test("the same words sent to another channel after a lost reply have a new identity", async ({ page, api }) => {
  const first = await api.channel.create({ name: "intent-first" });
  const second = await api.channel.create({ name: "intent-second" });
  const sent = await loseFirstReply(page);
  const box = await openFarmChat(page);
  await chooseChannel(page, "intent-first");
  await sendAndLoseReply(page, box, "两个频道都要收到");
  await chooseChannel(page, "intent-second");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(sent.map((s) => s.id)).toEqual([first, second]);
  expect(sent[1]!.sendKey).not.toBe(sent[0]!.sendKey);
  for (const id of [first, second]) expect((await api.channel.message.list({ id })).filter((m) => m.text === "两个频道都要收到")).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("new-channel-intent.png") });
});

test("changing the picked helper after a lost reply makes a new send intent", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "intent-helper" });
  const helpers = (await api.agent.list()).filter((a) => a.id !== orchestratorAgent && a.enabled).slice(0, 2);
  expect(helpers).toHaveLength(2);
  const sent = await loseFirstReply(page);
  const box = await openFarmChat(page);
  await chooseChannel(page, "intent-helper");
  const pick = async (name: string) => {
    const group = page.getByRole("group", { name: "帮工", exact: true });
    await group.getByRole("button", { name: "帮工", exact: true }).click();
    await group.getByRole("button", { name: `${name}，没在农场`, exact: true }).click();
    await group.getByRole("dialog", { name, exact: true }).getByRole("button", { name: "下一单派它" }).click();
    await page.getByRole("toolbar", { name: "农具" }).getByRole("button", { name: /^手/ }).click();
  };
  await pick(helpers[0]!.name);
  await sendAndLoseReply(page, box, "请这个帮工看看");
  await pick(helpers[1]!.name);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(sent.map((s) => s.agent)).toEqual(helpers.map((a) => a.id));
  expect(sent[1]!.sendKey).not.toBe(sent[0]!.sendKey);
  expect((await api.channel.message.list({ id: channel })).filter((m) => m.text === "请这个帮工看看")).toHaveLength(2);
});

test("a late successful response keeps the draft written while it was in flight", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "intent-edit" });
  let release!: () => void;
  const reply = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted = false;
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    const response = await route.fetch();
    accepted = true;
    await reply;
    await route.fulfill({ response });
  });
  const box = await openFarmChat(page);
  await chooseChannel(page, "intent-edit");
  await box.fill("已经送出去的那句话");
  await box.press("Enter");
  await expect.poll(() => accepted).toBe(true);
  await box.fill("后来写的这一稿不能清掉");
  release();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await expect(box).toHaveValue("后来写的这一稿不能清掉");
  expect((await api.channel.message.list({ id: channel })).filter((m) => m.text === "已经送出去的那句话")).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("later-draft-kept.png") });
});
