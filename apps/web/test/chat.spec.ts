import { defaultOrchestrator, type VibeValleyApi } from "@vibevalley/protocol";

import { composerOn, expect, tab, test, defaultChannel } from "./fixtures";

const newChannel = (api: VibeValleyApi, name: string) => api.channel.create({ name });

test("the default channel opens first, with the orchestrator resting", async ({ page, api }) => {
  const general = await defaultChannel(api);
  await page.goto("/chat");
  const side = page.getByTestId("channels-side");
  await expect(side.locator(`[data-testid="channel-row"][data-key="${general}"]`)).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("channel-orchestrator-line")).toHaveAttribute("data-state", "idle");
  await expect(tab(page, "chat")).toHaveAttribute("aria-selected", "true");
});

test("a sentence said shows in the list through the state stream, and the orchestrator answers", async ({ page, api }) => {
  const id = await newChannel(api, "talk");
  await page.goto(`/chat/${id}`);
  await expect(page.getByTestId("messages-empty")).toBeVisible();
  const box = await composerOn(page, id);
  await box.fill("run the tests once");
  await box.press("Enter");
  const messages = page.getByTestId("messages");
  await expect(messages.locator('[data-testid="message"][data-from-kind="owner"]').filter({ hasText: "run the tests once" })).toBeVisible();
  await expect(box).toHaveValue("");
  // Without a model key the orchestrator answers that it has none; the page takes that as any answer.
  await expect(messages.locator('[data-testid="message"][data-from-kind="orchestrator"]').first()).toBeVisible({ timeout: 15_000 });
});

test("the direct channel with the orchestrator: listed apart, talked in alone, with no one to @", async ({ page, api }) => {
  const general = await defaultChannel(api);
  await page.goto("/chat");
  const side = page.getByTestId("channels-side");
  await side.locator('[data-testid="channel-row"][data-type="direct"]').first().click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/u);
  const direct = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await expect(page.getByRole("tab")).toHaveCount(1);
  const box = await composerOn(page, direct);
  await box.click();
  await box.pressSequentially("just asking @");
  await expect(page.getByTestId("mentions")).toBeHidden();
  await box.fill("just asking: how is the field");
  await box.press("Enter");
  const messages = page.getByTestId("messages");
  await expect(messages.getByTestId("message").filter({ hasText: "how is the field" })).toBeVisible();
  // Without a model key the orchestrator answers that it has none, here and not in the default channel.
  await expect(messages.locator(`[data-testid="message"][data-from="${defaultOrchestrator}"]`).first()).toBeVisible({ timeout: 15_000 });
  await side.locator(`[data-testid="channel-row"][data-key="${general}"]`).click();
  await expect(page.getByTestId("messages").getByTestId("message").filter({ hasText: "how is the field" })).toHaveCount(0);
});

test("Shift+Enter starts a line and @ offers the orchestrator", async ({ page, api }) => {
  const id = await newChannel(api, "call");
  await page.goto(`/chat/${id}`);
  const box = await composerOn(page, id);
  await box.click();
  await box.pressSequentially("look @");
  const mentions = page.getByTestId("mentions");
  const orchestrator = mentions.getByRole("option").first();
  await expect(orchestrator).toBeVisible();
  const token = await orchestrator.getAttribute("data-key");
  await box.press("Enter");
  await expect(box).toHaveValue(`look ${token} `);
  await expect(mentions).toBeHidden();
  await box.press("Shift+Enter");
  await expect(box).toHaveValue(`look ${token} \n`);
});

test("a channel made in the dialog is shown at its own address, and a refused name stays with the reason", async ({ page, api }) => {
  await page.goto("/chat");
  await page.getByTestId("new-channel").click();
  const dialog = page.getByTestId("new-channel-dialog");
  await dialog.getByTestId("channel-name").fill("has spaces in it");
  await dialog.getByTestId("submit").click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await dialog.getByTestId("channel-name").fill("clock-in");
  await dialog.getByTestId("channel-description").fill("the clock-in app");
  await dialog.getByTestId("submit").click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/u);
  const id = page.url().split("/").at(-1)!;
  await expect(page.getByTestId("channel-head")).toHaveAttribute("data-key", id);
  await expect(page.getByTestId("channels-side").locator(`[data-testid="channel-row"][data-key="${id}"]`)).toHaveAttribute("aria-current", "page");
  const made = (await api.channel.list()).find((c) => c.id === id);
  expect([made?.name, made?.description]).toEqual(["clock-in", "the clock-in app"]);
});

test("the channel's settings save its description", async ({ page, api }) => {
  const id = await newChannel(api, "settings");
  await page.goto(`/chat/${id}`);
  await page.getByTestId("channel-settings-open").click();
  const dialog = page.getByTestId("channel-settings-dialog");
  await dialog.getByTestId("channel-description").fill("where settings go");
  await dialog.getByTestId("submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("channel-head")).toContainText("where settings go");
  expect((await api.channel.list()).find((c) => c.id === id)?.description).toBe("where settings go");
});

test("search keeps the messages that contain it, and Escape brings the rest back", async ({ page, api }) => {
  const id = await newChannel(api, "find");
  await api.channel.message.send({ id, text: "water the apples" });
  await api.channel.message.send({ id, text: "harvest the bananas" });
  await page.goto(`/chat/${id}`);
  const messages = page.getByTestId("messages");
  const bananas = messages.getByTestId("message").filter({ hasText: "harvest the bananas" });
  await expect(bananas).toBeVisible();
  await page.getByTestId("message-search-toggle").click();
  const search = page.getByTestId("message-search");
  await search.fill("apples");
  await expect(messages.getByTestId("message").filter({ hasText: "water the apples" })).toBeVisible();
  await expect(bananas).toBeHidden();
  await search.fill("melons");
  await expect(page.getByTestId("messages-empty")).toBeVisible();
  await search.press("Escape");
  await expect(bananas).toBeVisible();
});

test("the crons tab turns a cron off and deletes it on the second press", async ({ page, api }) => {
  const id = await newChannel(api, "timers");
  const made = await api.cron.create({ name: "run tests", text: "run the tests", channel: id, when: { kind: "once", at: Date.now() + 30 * 86400000 } });
  await page.goto(`/chat/${id}`);
  await tab(page, "jobs").click();
  await expect(page.getByTestId("tab-empty")).toBeVisible();
  await tab(page, "crons").click();
  const card = page.locator(`[data-testid="cron"][data-key="${made.id}"]`);
  const toggle = card.getByTestId("cron-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await card.getByTestId("delete").click();
  await card.getByTestId("delete-sure").click();
  await expect(page.getByTestId("tab-empty")).toBeVisible();
});

test("scrolled up from the newest, a pill leads back down", async ({ page, api }) => {
  const id = await newChannel(api, "long-talk");
  for (let i = 0; i < 40; i++) await api.channel.message.send({ id, text: `line ${i}` });
  const last = (await api.channel.message.list({ id })).find((m) => m.text === "line 39")!.id;
  await page.goto(`/chat/${id}`);
  const messages = page.getByTestId("messages");
  const newest = messages.locator(`[data-testid="message"][data-key="${last}"]`);
  await expect(newest).toBeVisible();
  await expect(page.getByTestId("to-latest")).toHaveCount(0);
  await messages.evaluate((el) => el.scrollTo({ top: -2000 }));
  await page.getByTestId("to-latest").click();
  await expect(newest).toBeInViewport();
  await expect(page.getByTestId("to-latest")).toHaveCount(0);
});

test("/ offers the commands, and /issue writes an issue instead of saying the line", async ({ page, api }) => {
  const id = await newChannel(api, "commands");
  await page.goto(`/chat/${id}`);
  const box = await composerOn(page, id);
  await box.click();
  await box.pressSequentially("/is");
  await expect(page.getByTestId("mentions").locator('[data-key="/issue"]')).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("/issue ");
  await box.pressSequentially("add paging to clock-in");
  await box.press("Enter");
  await expect(page.getByTestId("toast").first()).toBeVisible();
  await expect(box).toHaveValue("");
  await expect.poll(async () => (await api.issue.list({})).some((i) => i.title === "add paging to clock-in")).toBe(true);
  expect((await api.channel.message.list({ id })).some((m) => m.text.includes("/issue"))).toBe(false);
  // A line that only looks like one is said.
  await box.fill("where is /usr/bin");
  await box.press("Enter");
  await expect(page.getByTestId("messages").getByTestId("message").filter({ hasText: "where is /usr/bin" })).toBeVisible();
});
