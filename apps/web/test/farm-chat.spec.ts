// The farm's chat window and a plot's issue (src/farm/chat, src/farm/issue). The chat runs against the real server (it
// has no model key: the manager answers that it has none); the plot needs a helper on it, which tests cannot start, so
// that test serves a frame with one in place of the state stream.

import type { Page } from "@playwright/test";
import type { Issue, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function openFarm(page: Page) {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

test("a sentence said in 田头 shows in the window, and the manager answers it", async ({ page }) => {
  await openFarm(page);
  const chat = page.getByRole("region", { name: "田头" });
  await expect(chat.getByText("这里是田头")).toBeVisible();
  const box = chat.getByRole("textbox", { name: "对管家说，@ 叫帮工…" });
  await box.fill("给打卡页加一个夜间模式");
  await box.press("Enter");
  await expect(chat.getByText("给打卡页加一个夜间模式")).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(chat.getByText(/还没有 DeepSeek 的钥匙/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath("chat.png") });
});

test("the channel menu makes a channel and shows it; the face folds the window", async ({ page }) => {
  await openFarm(page);
  const chat = page.getByRole("region", { name: "田头" });
  await chat.getByRole("button", { name: /^频道：田头/ }).click();
  await page.getByRole("dialog", { name: "频道" }).getByRole("button", { name: "开新频道" }).click();
  await page.getByRole("textbox", { name: "频道名" }).fill("clock");
  await page.getByRole("button", { name: "开", exact: true }).click();
  await expect(chat.getByRole("button", { name: /^频道：#clock/ })).toBeVisible();
  await chat.getByRole("button", { name: "收起对话" }).last().click();
  await expect(chat.getByText("这里是田头")).toHaveCount(0);
  await chat.getByRole("button", { name: "展开对话" }).click();
  await expect(chat.getByRole("button", { name: /^频道：#clock/ })).toBeVisible();
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
    id: "w1",
    name: "阿狐",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: Date.now() - 600_000,
    runs: 1,
    phase: { _tag: "ripe" },
    issue: made.id,
    lastRun: { outcome: "completed", summary: "做完了，测试全过", at: Date.now() - 60_000 } as never,
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] } as never,
  };
  // What the server would say of an issue handed back: it may be harvested (done) or closed.
  const issue: Issue = {
    ...made,
    sessions: ["w1"],
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
