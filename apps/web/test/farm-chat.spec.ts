// The farm's chat, the unfolded phone's right screen, and a plot's issue (src/farm/chat, src/farm/issue). The chat runs
// against the real server (it has no model key: the orchestrator answers that it has none; its pi is the scripted helper,
// fixtures.ts); the plot's test serves a frame with a helper in place of the state stream.

import type { Page } from "@playwright/test";
import type { Agent, Issue, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath, pathOf } from "@vibevalley/protocol";
import { buttons, composerOn, defaultChannel, expect, gate, test } from "./fixtures";
import { sessionId } from "@vibevalley/protocol/schema";

test.use({ farm: "farm-chat" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function openFarm(page: Page) {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

/** The phone out and unfolded: its right screen is the farm chat. */
async function openChat(page: Page) {
  await page.getByTestId("phone-button").click();
  await page.getByTestId("phone-chat").click();
  return page.getByTestId("farm-chat");
}

/** A message in the farm chat by its id. */
const row = (page: Page, id: string) => page.getByTestId("farm-chat").locator(`[data-testid="message"][data-key="${id}"]`);

const scripted: Agent = {
  id: "",
  name: "fox",
  role: "worker",
  duty: "",
  enabled: true,
  // The test server's pi is the scripted helper (fixtures.ts).
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

test("a sentence said in the farm chat shows in the window, and the orchestrator answers it", async ({ page, api }) => {
  const general = await defaultChannel(api);
  await openFarm(page);
  await expect(page.getByTestId("farm-chat")).toHaveCount(0);
  const chat = await openChat(page);
  const box = await composerOn(chat, general);
  await box.fill("add a night mode to the clock-in page");
  await box.press("Enter");
  await expect(chat.locator('[data-testid="message"][data-from-kind="owner"]').filter({ hasText: "add a night mode" })).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(chat.locator('[data-testid="message"][data-from-kind="orchestrator"]').first()).toBeVisible({ timeout: 15_000 });
});

// Sent words show at once, before the server has them, and once when it does.
test("a sentence shows at once while the server takes its time, and only once after", async ({ page, api }) => {
  const general = await defaultChannel(api);
  await openFarm(page);
  const chat = await openChat(page);
  // The server takes its time: until the test has seen the sentence shown before it.
  const server = gate();
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    await server.opened;
    await route.continue();
  });
  const box = await composerOn(chat, general);
  await box.fill("leave the database alone");
  await box.press("Enter");
  await expect(chat.locator('[data-testid="message"][data-state="sending"]')).toContainText("leave the database alone");
  await expect(box).toHaveValue("");
  server.open();
  await expect(chat.locator('[data-testid="message"][data-state="sending"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(chat.getByTestId("message").filter({ hasText: "leave the database alone" })).toHaveCount(1);
});

test("the channel menu lists the direct channel with the orchestrator, and a sentence said there stays there", async ({ page, api }) => {
  const direct = (await api.channel.list()).find((c) => c.type === "direct")!;
  await openFarm(page);
  const chat = await openChat(page);
  await chat.getByTestId("channel-menu").click();
  await page.getByTestId("channels").locator(`[data-key="${direct.id}"]`).click();
  await expect(chat.getByTestId("channel-menu")).toHaveAttribute("data-key", direct.id);
  const box = await composerOn(chat, direct.id);
  await box.fill("just between us");
  await box.press("Enter");
  await expect(chat.getByTestId("message").filter({ hasText: "just between us" })).toBeVisible();
  expect((await api.channel.message.list({ id: direct.id })).some((m) => m.text === "just between us")).toBe(true);
});

test("the channel menu makes a channel and shows it; folding keeps it, Esc folds and then puts the phone away", async ({ page, api }) => {
  await openFarm(page);
  const chat = await openChat(page);
  await chat.getByTestId("channel-menu").click();
  await page.getByTestId("channels").getByTestId("new-channel").click();
  await page.getByTestId("channels").getByTestId("channel-name").fill("clock");
  await page.getByTestId("channels").getByTestId("form-submit").click();
  await expect.poll(async () => (await api.channel.list()).find((c) => c.name === "clock")?.id).toBeTruthy();
  const clock = (await api.channel.list()).find((c) => c.name === "clock")!.id;
  await expect(chat.getByTestId("channel-menu")).toHaveAttribute("data-key", clock);
  await chat.getByTestId("chat-fold").last().click();
  await expect(chat).toHaveCount(0);
  const phone = page.getByTestId("phone");
  await expect(phone).toHaveAttribute("data-screen", "home");
  await page.getByTestId("phone-chat").click();
  await expect(chat.getByTestId("channel-menu")).toHaveAttribute("data-key", clock);
  await page.keyboard.press("Escape");
  await expect(chat).toHaveCount(0);
  await expect(phone).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(phone).toHaveCount(0);
  // Put away, it comes out folded.
  await page.getByTestId("phone-button").click();
  await expect(phone).toBeVisible();
  await expect(chat).toHaveCount(0);
});

// A dispatch note is one line until opened, truncated inside its column: a long one once ran past the window's edge.
test("a dispatch note stays inside its column", async ({ page, api }) => {
  const fox = await api.agent.create(scripted);
  const project = await api.project.create({ name: "clock" });
  const made = await api.issue.create({
    title: "add a make-up clock-in button that asks for a reason and tells the team lead, and keep it inside its column",
    project: project.name,
    assignee: fox.id,
  });
  await api.issue.status.update({ id: made.id, status: "todo" });
  await openFarm(page);
  const chat = await openChat(page);
  const note = chat.getByTestId("dispatch-note").first();
  await expect(note).toBeVisible({ timeout: 20_000 });
  const [bubble, column] = await note.evaluate((b) => [
    b.parentElement!.getBoundingClientRect().width,
    b.parentElement!.parentElement!.getBoundingClientRect().width,
  ]);
  expect(bubble).toBeLessThanOrEqual(column);
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

test("a click on a helper's plot opens its issue: its state, the acts and the folds", async ({ page, server, api }) => {
  const made = await api.issue.create({ title: "finish remember-me" });
  const frame = await firstFrame(server.url);
  const session: Session = {
    id: sessionId("w1"),
    name: "fox",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: Date.now() - 600_000,
    runs: 1,
    phase: { _tag: "done" },
    issue: made.id,
    lastRun: { outcome: "completed", summary: "done, tests pass", at: Date.now() - 60_000 } as never,
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
  };
  // What the server would say of an issue handed back: it may be completed (done) or canceled.
  const issue: Issue = {
    ...made,
    sessions: [sessionId("w1")],
    status: "in_review",
    moves: ["done", "canceled"],
    criteria: ["still logged in after reopening"],
    attention: { state: "reviewing", since: Date.now() - 60_000, lead: "complete", acts: buttons("complete", "reject", "tell", "close") },
  };
  const fixture: StateFrame = {
    ...frame,
    state: { ...frame.state, sessions: [session], issues: [issue] },
    view: { ...frame.view, plots: { [made.id]: { crop: "wheat" } } },
  };
  await page.route("**/api/v1/state", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(fixture)}\n\n` }),
  );
  await openFarm(page);
  const box = (await page.getByTestId("village").locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  const view = page.getByTestId("plot");
  await expect(view.getByTestId("issue-now")).toHaveAttribute("data-state", "reviewing");
  await expect(view.locator('[data-act="complete"]').first()).toBeVisible();
  await expect(view.locator('[data-act="reject"]')).toBeVisible();
  // Each fold opens whatever was opened before it: content first mounted by a click once held the whole update while
  // its queries were in flight, and the fold stayed shut.
  const folds = view.getByTestId("fold");
  for (let i = 0; i < (await folds.count()); i++) {
    await folds.nth(i).click();
    await expect(folds.nth(i)).toHaveAttribute("aria-expanded", "true");
  }
  const tick = view.locator('[data-testid="criterion-tick"][data-key="0"]');
  await tick.click();
  await expect(tick).toHaveAttribute("aria-pressed", "true");
});

test("a message in the farm chat is reacted to, answered, changed and deleted from its menu", async ({ page, api }) => {
  const general = await defaultChannel(api);
  await openFarm(page);
  const chat = await openChat(page);
  const box = await composerOn(chat, general);
  await box.fill("turn the south field");
  await box.press("Enter");
  await expect.poll(async () => (await api.channel.message.list({ id: general })).some((m) => m.text === "turn the south field")).toBe(true);
  const id = (await api.channel.message.list({ id: general })).find((m) => m.text === "turn the south field")!.id;
  const menu = row(page, id).getByTestId("message-menu");
  const open = async () => {
    await row(page, id).hover();
    await row(page, id).getByTestId("message-menu-open").click();
  };

  await open();
  await menu.locator('[data-testid="quick-reaction"][data-key="🎉"]').click();
  await expect(row(page, id).locator('[data-testid="reaction"][data-key="🎉"]')).toHaveAttribute("data-count", "1");

  await open();
  await menu.locator('[data-key="reply"]').click();
  await expect(chat.getByTestId("replying")).toBeVisible();
  await chat.getByTestId("cancel-reply").click();
  await expect(chat.getByTestId("replying")).toHaveCount(0);

  await open();
  await menu.locator('[data-key="edit"]').click();
  const editing = row(page, id).getByTestId("message-edit");
  await editing.fill("turn the north field");
  await editing.press("Enter");
  await expect(row(page, id)).toContainText("turn the north field");

  await open();
  const remove = menu.locator('[data-key="delete"]');
  await remove.click();
  await expect(remove).toHaveAttribute("data-sure", "");
  await remove.click();
  await expect(row(page, id)).toHaveAttribute("data-deleted", "");
});
