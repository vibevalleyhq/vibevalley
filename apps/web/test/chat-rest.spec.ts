import type { Page } from "@playwright/test";
import type { Agent, VibeValleyApi } from "@vibevalley/protocol";
import { composerOn, expect, test } from "./fixtures";

const side = (page: Page) => page.getByTestId("channels-side");
const channelRow = (page: Page, id: string) => side(page).locator(`[data-testid="channel-row"][data-key="${id}"]`);
const row = (page: Page, id: string) => page.getByTestId("messages").locator(`[data-testid="message"][data-key="${id}"]`);
const idOf = async (api: VibeValleyApi, channel: string, text: string) => (await api.channel.message.list({ id: channel })).find((m) => m.text === text)!.id;

test("a channel is renamed, grouped, quieted, archived and deleted from its settings", async ({ page, api }) => {
  const id = await api.channel.create({ name: "chores" });
  await page.goto(`/chat/${id}`);
  await page.getByTestId("channel-settings-open").click();
  const dialog = page.getByTestId("channel-settings-dialog");
  await dialog.getByTestId("channel-name").fill("errands");
  await dialog.getByTestId("channel-category").fill("daily");
  await dialog.getByTestId("channel-notify").locator('[data-key="none"]').click();
  await dialog.getByTestId("submit").click();
  await expect(page.getByTestId("channel-head")).toContainText("errands");
  const group = side(page).locator('[data-testid="side-section"][data-key="category:daily"]');
  await expect(group.locator(`[data-testid="channel-row"][data-key="${id}"]`)).toHaveAttribute("data-notify", "none");

  await page.getByTestId("channel-settings-open").click();
  await dialog.getByTestId("channel-archive").click();
  await expect(group).toHaveCount(0);
  const archived = side(page).locator('[data-testid="side-section"][data-key="archived"]');
  await archived.getByTestId("side-section-toggle").click();
  await expect(archived.locator(`[data-testid="channel-row"][data-key="${id}"]`)).toBeVisible();

  await page.getByTestId("channel-settings-open").click();
  await dialog.getByTestId("channel-remove").click();
  await dialog.getByTestId("channel-remove-sure").click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(channelRow(page, id)).toHaveCount(0);
});

test("a channel dropped on another is placed before it", async ({ page, api }) => {
  const first = await api.channel.create({ name: "first" });
  await api.channel.create({ name: "second" });
  const third = await api.channel.create({ name: "third" });
  await page.goto(`/chat/${first}`);
  await channelRow(page, third).dragTo(channelRow(page, first));
  // The worker's server has other files' channels too: what counts is third's place against first's.
  const before = () =>
    side(page)
      .locator('[data-testid="side-section"][data-key="channels"] [data-testid="channel-row"]')
      .evaluateAll(
        (rows, [a, b]) => {
          const keys = rows.map((r) => r.getAttribute("data-key"));
          return keys.indexOf(a!) < keys.indexOf(b!);
        },
        [third, first],
      );
  await expect.poll(before).toBe(true);
  await page.reload();
  await expect(channelRow(page, first)).toBeVisible();
  expect(await before()).toBe(true);
});

test("a thread is listed under its channel, renamed and archived there", async ({ page, api }) => {
  const id = await api.channel.create({ name: "threads" });
  await api.channel.message.send({ id, text: "open a thread on this" });
  const [said] = await api.channel.message.list({ id });
  const thread = await api.channel.thread.create({ id: said!.id });
  await page.goto(`/chat/${id}`);
  // A thread on no issue, with no replies yet, is a thread, not an issue's.
  await expect(page.locator(`[data-testid="thread-preview"][data-key="${thread}"]`)).not.toHaveAttribute("data-subject", "issue");
  await page.getByTestId("threads-toggle").click();
  const list = page.getByTestId("thread-list");
  const item = list.locator(`[data-testid="thread"][data-key="${thread}"]`);
  await item.hover();
  await item.getByTestId("thread-rename").click();
  await item.getByTestId("thread-name").fill("the thread's subject");
  await item.getByTestId("thread-name").press("Enter");
  await expect(item).toContainText("the thread's subject");
  await item.getByTestId("thread-archive").click();
  await expect(list.getByTestId("threads-empty")).toBeVisible();
  await list.getByTestId("threads-archived").click();
  await expect(item).toHaveAttribute("data-archived", "");
});

test("a message's address scrolls to it and lights it up, from the pins, a reply's quote and the farm's search", async ({ page, api }) => {
  const id = await api.channel.create({ name: "long" });
  for (let i = 1; i <= 70; i++) await api.channel.message.send({ id, text: `line ${i}` });
  // The orchestrator answers too (it has no key): the owner's lines are not numbered 1 to 70.
  const all = [...(await api.channel.message.list({ id, before: 1000, limit: 100 })), ...(await api.channel.message.list({ id, before: 40, limit: 100 }))];
  const find = (text: string) => all.find((m) => m.text === text)!;
  const first = find("line 1");
  await api.channel.pin.toggle({ id: first.id });
  await api.channel.message.send({ id, text: "back to the start", replyTo: find("line 2").number });

  await page.goto(`/chat/${id}`);
  const at = (n: number) => page.getByTestId("messages").locator(`[data-number="${n}"]`);
  await page.getByTestId("pins-toggle").click();
  await page.getByTestId("pins").locator(`[data-testid="pin"][data-key="${first.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}\\?m=${first.number}$`));
  await expect(at(first.number)).toBeInViewport();
  await expect(at(first.number)).toHaveAttribute("data-lit", "");

  await page.goto(`/chat/${id}`);
  await page
    .getByTestId("messages")
    .locator(`[data-testid="quote"][data-key="${find("line 2").number}"]`)
    .click();
  await expect(page).toHaveURL(new RegExp(`\\?m=${find("line 2").number}$`));
  await expect(at(find("line 2").number)).toBeInViewport();

  await page.getByTestId("farm-search-open").click();
  const search = page.getByTestId("farm-search");
  await search.getByTestId("farm-search-input").fill("in:#long line 33");
  await search.locator(`[data-testid="search-hit"][data-key="${find("line 33").id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?m=${find("line 33").number}$`));
  await expect(at(find("line 33").number)).toBeInViewport();
});

test("the box keeps its draft across a reload; ↑ edits the last message, Esc lets go of a reply, emoji go in at the caret", async ({ page, api }) => {
  const id = await api.channel.create({ name: "typing" });
  await api.channel.message.send({ id, text: "as it was" });
  const said = await idOf(api, id, "as it was");
  await page.goto(`/chat/${id}`);
  const box = await composerOn(page, id);
  await expect(row(page, said)).toBeVisible();

  await box.click();
  await box.press("ArrowUp");
  const editing = row(page, said).getByTestId("message-edit");
  await editing.fill("as it is now");
  await editing.press("Enter");
  await expect(row(page, said)).toContainText("as it is now");

  await row(page, said).hover();
  await row(page, said).locator('[data-testid="message-tool"][data-key="reply"]').click();
  await expect(page.getByTestId("replying")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByTestId("replying")).toHaveCount(0);

  await box.fill("not done yet");
  await page.getByTestId("composer").getByTestId("emoji").click();
  await page.getByTestId("emoji-picker").locator('[data-key="🌾"]').click();
  await expect(box).toHaveValue("not done yet🌾");
  await page.reload();
  await expect(await composerOn(page, id)).toHaveValue("not done yet🌾");
});

test("a file dropped on the channel goes up; a video plays in place and a PDF opens in its own tab", async ({ page, api }) => {
  const id = await api.channel.create({ name: "media" });
  await page.goto(`/chat/${id}`);
  const box = await composerOn(page, id);
  const drop = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["fake video"], "clip.mp4", { type: "video/mp4" }));
    dt.items.add(new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" }));
    return dt;
  });
  const messages = page.getByTestId("messages");
  await messages.dispatchEvent("dragover", { dataTransfer: drop });
  await expect(page.getByTestId("drop-hint")).toBeVisible();
  await messages.dispatchEvent("drop", { dataTransfer: drop });
  await expect(page.locator('[data-testid="pending-file"][data-key="clip.mp4"]')).toBeVisible();
  await expect(page.locator('[data-testid="pending-file"][data-key="notes.pdf"]')).toBeVisible();
  await box.press("Enter");
  await expect(messages.locator('[data-testid="attachment"][data-kind="video"]')).toBeVisible();
  await expect(messages.locator('[data-testid="attachment"][data-kind="pdf"]')).toHaveAttribute("target", "_blank");

  const [said] = await api.channel.message.list({ id });
  await row(page, said!.id).hover();
  await row(page, said!.id).locator('[data-testid="message-tool"][data-key="edit"]').click();
  await row(page, said!.id).locator('[data-testid="edit-file"][data-key="notes.pdf"]').click();
  await row(page, said!.id).getByTestId("message-edit").press("Enter");
  await expect(messages.locator('[data-testid="attachment"][data-kind="pdf"]')).toHaveCount(0);
  await expect(messages.locator('[data-testid="attachment"][data-kind="video"]')).toHaveCount(1);
});

const helper: Agent = {
  id: "",
  name: "fox",
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};

test("the owner talks with a helper profile alone, and its answer can be marked unread", async ({ page, api }) => {
  const fox = await api.agent.create(helper);
  await api.project.create({ name: "talk-farm" });
  await page.goto("/chat");
  await page.getByTestId("new-direct").click();
  await page.getByTestId("direct-picker").locator(`[data-key="${fox.id}"]`).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const direct = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  const box = await composerOn(page, direct);
  await box.fill("what is in the repository?");
  await box.press("Enter");
  const answer = page.getByTestId("messages").locator('[data-testid="message"]:not([data-from-kind="owner"])').last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(channelRow(page, direct)).toBeVisible();

  await answer.hover();
  await answer.locator('[data-testid="message-tool"][data-key="more"]').click();
  await answer.locator('[role="menuitem"][data-key="mark-unread"]').click();
  await side(page).locator('[data-testid="side-section"][data-key="channels"] [data-testid="channel-row"]').first().click();
  await expect(channelRow(page, direct)).toHaveAttribute("data-unread", /^[1-9]/);
});

test("a reaction can be any emoji, picked from the toolbar or beside the reactions a message has", async ({ page, api }) => {
  const id = await api.channel.create({ name: "emoji" });
  await api.channel.message.send({ id, text: "planted sunflowers" });
  const said = await idOf(api, id, "planted sunflowers");
  await page.goto(`/chat/${id}`);
  await row(page, said).hover();
  await row(page, said).locator('[data-testid="message-tool"][data-key="react"]').click();
  await row(page, said).getByTestId("more-emoji").click();
  await page.getByTestId("emoji-picker").locator('[data-key="🌻"]').click();
  const sunflower = row(page, said).locator('[data-testid="reaction"][data-key="🌻"]');
  await expect(sunflower).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("emoji-picker")).toHaveCount(0);

  await row(page, said).hover();
  await row(page, said).getByTestId("add-reaction").click();
  await page.getByTestId("emoji-picker").locator('[data-key="🍀"]').click();
  await expect(row(page, said).locator('[data-testid="reaction"][data-key="🍀"]')).toHaveAttribute("data-count", "1");
});

test("Ctrl+K jumps to a channel by its name from anywhere, and opens a talk with a profile", async ({ page, api }) => {
  const id = await api.channel.create({ name: "front-desk" });
  const badger = await api.agent.create({ ...helper, name: "badger" });
  await page.goto("/issues");
  await page.keyboard.press("Control+k");
  const dialog = page.getByTestId("switcher");
  const box = dialog.getByTestId("switcher-input");
  await box.fill("#front");
  await expect(dialog.getByRole("option").first()).toHaveAttribute("data-key", id);
  await box.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  await expect(dialog).toBeHidden();

  await page.getByTestId("switcher-open").click();
  await box.fill("@badger");
  const first = dialog.getByRole("option").first();
  await expect(first).toHaveAttribute("data-kind", "profile");
  await expect(first).toHaveAttribute("data-key", badger.id);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await expect(page).not.toHaveURL(new RegExp(`/chat/${id}$`));
});

test("a link to a farm message shows that message under it, and a press goes there", async ({ page, api, server }) => {
  const from = await api.channel.create({ name: "source" });
  await api.channel.message.send({ id: from, text: "the apples on the south slope are ripe" });
  const [said] = (await api.channel.message.list({ id: from })).filter((m) => m.text === "the apples on the south slope are ripe");
  const to = await api.channel.create({ name: "retold" });
  await api.channel.message.send({ id: to, text: `look ${server.url}/chat/${from}?m=${said!.number}` });
  await page.goto(`/chat/${to}`);
  const card = page.getByTestId("messages").locator(`[data-testid="linked-message"][data-key="${from}:${said!.number}"]`);
  await expect(card).toContainText("the apples on the south slope are ripe");
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/chat/${from}\\?m=${said!.number}$`));
  // The server reads no preview of the farm's own address.
  const [linking] = (await api.channel.message.list({ id: to })).filter((m) => m.text.startsWith("look "));
  expect(linking!.embeds ?? []).toEqual([]);
});
