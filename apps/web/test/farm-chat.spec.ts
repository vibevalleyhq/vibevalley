// The farm's chat, the unfolded phone's right screen, and a plot's issue (src/farm/chat, src/farm/issue). The chat runs
// against the real server (it has no model key: the orchestrator answers that it has none; its pi is the scripted helper,
// fixtures.ts); the plot's test serves a frame with a helper in place of the state stream.

import type { Page } from "@playwright/test";
import type { Agent, Issue, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";
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
  await page.route("**/api/v1/say", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const box = chat.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
  await box.fill("先别动数据库");
  await box.press("Enter");
  await expect(chat.getByLabel("发送中")).toContainText("先别动数据库", { timeout: 500 });
  await expect(box).toHaveValue("");
  await expect(chat.getByLabel("发送中")).toHaveCount(0, { timeout: 10_000 });
  await expect(chat.getByText("先别动数据库", { exact: true })).toHaveCount(1);
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
  const fox = await api.agent.create({ body: scripted });
  const project = await api.project.create({ body: { name: "clock" } });
  const made = await api.issue.create({ body: { title: "给打卡页加一个补卡按钮，补卡要写原因，还要发通知给组长", project: project.name, assignee: fox.id } });
  await api.issue.status({ id: made.id, body: { status: "todo" } });
  await openFarm(page);
  const chat = await openChat(page);
  const note = chat.getByRole("button", { name: "展开派活" }).first();
  await expect(note).toBeVisible({ timeout: 20_000 });
  const [bubble, column] = await note.evaluate((b) => [
    b.parentElement!.getBoundingClientRect().width,
    b.parentElement!.parentElement!.getBoundingClientRect().width,
  ]);
  expect(bubble).toBeLessThanOrEqual(column!);
  await page.screenshot({ path: test.info().outputPath("dispatch.png") });
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

test("a click on a helper's plot opens its issue: its state, the box and the offers", async ({ page, server, api }) => {
  const made = await api.issue.create({ body: { title: "把登录页的记住我做完" } });
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
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] } as never,
  };
  // What the server would say of an issue handed back: it may be completed (done) or canceled.
  const issue: Issue = {
    ...made,
    sessions: [sessionId("w1")],
    status: "in_review",
    moves: ["done", "canceled"],
    criteria: ["勾上后重开浏览器还登着"],
    review: "required",
    attention: { state: "reviewing", since: Date.now() - 60_000, lead: "accept", acts: ["accept", "reject", "tell", "close"] },
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
  await expect(view.getByRole("button", { name: "验收通过" })).toBeVisible();
  await expect(view.getByRole("button", { name: "打回" })).toBeVisible();
  await expect(view.getByRole("button", { name: "收获" })).toHaveCount(0);
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
