// The farm's chat, the unfolded phone's right screen, and a plot's issue (src/farm/chat, src/farm/issue). The chat runs
// against the real server (it has no model key: the orchestrator answers that it has none; its pi is the scripted helper,
// fixtures.ts); the plot's test serves a frame with a helper in place of the state stream.

import type { Page } from "@playwright/test";
import type { Agent, Issue, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath, pathOf } from "@vibevalley/protocol";
import { buttons, expect, gate, test } from "./fixtures";
import { sessionId } from "@vibevalley/protocol/schema";

test.use({ farm: "farm-chat" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function openFarm(page: Page) {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

/** The phone out and unfolded: its right screen is 田头. */
async function openChat(page: Page) {
  await page.getByRole("button", { name: "手机" }).click();
  await page.getByRole("button", { name: /^展开田头/ }).click();
  return page.getByRole("region", { name: "田头" });
}

const scripted: Agent = {
  id: "",
  name: "阿狐",
  role: "",
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

test("a sentence said in 田头 shows in the window, and the orchestrator answers it", async ({ page }) => {
  await openFarm(page);
  await expect(page.getByRole("region", { name: "田头" })).toHaveCount(0);
  const chat = await openChat(page);
  await expect(chat.getByText("这里是田头")).toBeVisible();
  const box = chat.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
  await box.fill("给打卡页加一个夜间模式");
  await box.press("Enter");
  await expect(chat.getByText("给打卡页加一个夜间模式")).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(chat.getByText(/还没有 DeepSeek 的钥匙/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath("chat.png") });
});

// Sent words show at once, before the server has them, and once when it does.
test("a sentence shows at once while the server takes its time, and only once after", async ({ page }) => {
  await openFarm(page);
  const chat = await openChat(page);
  // The server takes its time: until the test has seen the sentence shown before it.
  const server = gate();
  await page.route(`**${pathOf("channel.message.send")}`, async (route) => {
    await server.opened;
    await route.continue();
  });
  const box = chat.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
  await box.fill("先别动数据库");
  await box.press("Enter");
  await expect(chat.getByLabel("发送中")).toContainText("先别动数据库");
  await expect(box).toHaveValue("");
  server.open();
  await expect(chat.getByLabel("发送中")).toHaveCount(0, { timeout: 10_000 });
  await expect(chat.getByText("先别动数据库", { exact: true })).toHaveCount(1);
});

test("the channel menu lists the direct channel with the orchestrator, and a sentence said there stays there", async ({ page }) => {
  await openFarm(page);
  const chat = await openChat(page);
  await chat.getByRole("button", { name: /^频道：田头/ }).click();
  const menu = page.getByRole("dialog", { name: "频道" });
  await expect(menu.getByText("私聊", { exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "管家" }).click();
  await expect(chat.getByRole("button", { name: /^频道：管家/ })).toBeVisible();
  const box = chat.getByRole("textbox");
  await box.fill("只跟你说");
  await box.press("Enter");
  await expect(chat.getByRole("log", { name: "管家" }).getByText("只跟你说")).toBeVisible();
});

test("the channel menu makes a channel and shows it; folding keeps it, Esc folds and then puts the phone away", async ({ page }) => {
  await openFarm(page);
  const chat = await openChat(page);
  await chat.getByRole("button", { name: /^频道：田头/ }).click();
  await page.getByRole("dialog", { name: "频道" }).getByRole("button", { name: "开新频道" }).click();
  await page.getByRole("textbox", { name: "频道名" }).fill("clock");
  await page.getByRole("button", { name: "开", exact: true }).click();
  await expect(chat.getByRole("button", { name: /^频道：#clock/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("unfolded.png") });
  await chat.getByRole("button", { name: "收起对话" }).last().click();
  await expect(chat).toHaveCount(0);
  const phone = page.getByRole("region", { name: "农场手机" });
  await expect(phone.getByText("农场通")).toBeVisible();
  await page.getByRole("button", { name: /^展开田头/ }).click();
  await expect(chat.getByRole("button", { name: /^频道：#clock/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chat).toHaveCount(0);
  await expect(phone).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(phone).toHaveCount(0);
  // Put away, it comes out folded.
  await page.getByRole("button", { name: "手机" }).click();
  await expect(phone).toBeVisible();
  await expect(chat).toHaveCount(0);
});

// A dispatch note is one line until opened, truncated inside its column: a long one once ran past the window's edge.
test("a dispatch note stays inside its column", async ({ page, api }) => {
  const fox = await api.agent.create(scripted);
  const project = await api.project.create({ name: "clock" });
  const made = await api.issue.create({ title: "给打卡页加一个补卡按钮，补卡要写原因，还要发通知给组长", project: project.name, assignee: fox.id });
  await api.issue.status.update({ id: made.id, status: "todo" });
  await openFarm(page);
  const chat = await openChat(page);
  const note = chat.getByRole("button", { name: "展开派活" }).first();
  await expect(note).toBeVisible({ timeout: 20_000 });
  const [bubble, column] = await note.evaluate((b) => [
    b.parentElement!.getBoundingClientRect().width,
    b.parentElement!.parentElement!.getBoundingClientRect().width,
  ]);
  expect(bubble).toBeLessThanOrEqual(column);
  await page.screenshot({ path: test.info().outputPath("dispatch.png") });
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

test("a click on a helper's plot opens its issue: its state, the box and the offers", async ({ page, server, api }) => {
  const made = await api.issue.create({ title: "把登录页的记住我做完" });
  const frame = await firstFrame(server.url);
  const session: Session = {
    id: sessionId("w1"),
    name: "阿狐",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: Date.now() - 600_000,
    runs: 1,
    phase: { _tag: "done" },
    issue: made.id,
    lastRun: { outcome: "completed", summary: "做完了，测试全过", at: Date.now() - 60_000 } as never,
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
  };
  // What the server would say of an issue handed back: it may be completed (done) or canceled.
  const issue: Issue = {
    ...made,
    sessions: [sessionId("w1")],
    status: "in_review",
    moves: ["done", "canceled"],
    criteria: ["勾上后重开浏览器还登着"],
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
  const view = page.getByRole("dialog", { name: "阿狐的地" });
  await expect(view).toBeVisible();
  await expect(view.getByLabel("现在怎样")).toContainText("等你验收");
  await expect(view.getByRole("button", { name: "收获" }).first()).toBeVisible();
  await expect(view.getByRole("button", { name: "打回" })).toBeVisible();
  // Each fold opens whatever was opened before it: content first mounted by a click once held the whole update while
  // its queries were in flight, and the fold stayed shut.
  for (const name of ["详情", "每次干活", "帮工的每一步", "怎么走到这一步"]) {
    const fold = view.getByRole("button", { name: new RegExp("^" + name) });
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
  }
  await view.getByRole("button", { name: "勾上后重开浏览器还登着" }).click();
  await expect(view.getByRole("button", { name: "勾上后重开浏览器还登着" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: test.info().outputPath("plot.png") });
});

test("a message in 田头 is reacted to, answered, changed and deleted from its ⋯", async ({ page }) => {
  await openFarm(page);
  const chat = await openChat(page);
  const box = chat.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
  await box.fill("南边的地要翻");
  await box.press("Enter");
  await expect(chat.getByText("南边的地要翻", { exact: true })).toBeVisible();
  const menu = chat.getByRole("menu", { name: "这条消息能做的" });
  // Its own row's: the shared farm has other messages, each with a menu.
  const rowOf = (text: string) => chat.locator('[class*="group/m"]').filter({ has: page.getByText(text, { exact: true }) });
  const open = async (text = "南边的地要翻") => {
    await rowOf(text).hover();
    await rowOf(text).getByRole("button", { name: "这条消息能做的" }).click();
  };

  await open();
  await menu.getByRole("button", { name: "🎉" }).click();
  await expect(chat.getByText("🎉 1")).toBeVisible();

  await open();
  await menu.getByRole("menuitem", { name: "回复" }).click();
  await expect(chat.getByText("回复 主人：南边的地要翻")).toBeVisible();
  await chat.getByRole("button", { name: "不回复了" }).click();

  await open();
  await menu.getByRole("menuitem", { name: "改" }).click();
  const editing = chat.getByRole("textbox", { name: "改" });
  await editing.fill("北边的地要翻");
  await editing.press("Enter");
  await expect(chat.getByText("北边的地要翻", { exact: true })).toBeVisible();

  await open("北边的地要翻");
  await menu.getByRole("menuitem", { name: "删掉" }).click();
  await menu.getByRole("menuitem", { name: "再点一次删掉" }).click();
  await expect(chat.getByText("这条消息已删除")).toBeVisible();
});
