// The farm phone (src/farm/phone): it opens over its button, a game takes the pad and its keys, Esc puts it away; a
// new call in the inbox rings it open, and answering goes to what called. The call needs a helper and an inbox item,
// which tests cannot make, so that test serves frames in place of the state stream: the stream ends after each, and
// the page reconnects a second later to the next.

import type { Page } from "@playwright/test";
import type { InboxItem, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function openFarm(page: Page) {
  await page.goto("/farm/");
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

test("the phone opens over its button, a game takes the pad, and Esc puts it away", async ({ page }) => {
  await openFarm(page);
  await page.getByRole("button", { name: "手机" }).click();
  const phone = page.getByRole("region", { name: "农场手机" });
  await expect(phone.getByText("农场通")).toBeVisible();
  await expect(phone.getByRole("button", { name: "上" })).toHaveAttribute("aria-disabled", "true");
  await phone.getByRole("button", { name: "方块" }).click();
  await expect(phone.getByText("按 A 开始")).toBeVisible();
  await expect(phone.getByRole("button", { name: "上" })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Space");
  await expect(phone.getByText("按 A 开始")).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("x");
  await expect(phone.getByText("按 A 继续")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("phone-blocks.png") });
  await phone.getByRole("button", { name: "主屏" }).click();
  await phone.getByRole("button", { name: "种田 2048" }).click();
  await page.keyboard.press("Enter");
  await expect(phone.getByRole("img", { name: /^田里：2 株/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(phone).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "菜单" })).toHaveCount(0);
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.signal.aborted || abort.abort()), abort.signal).catch(
      (e) => abort.signal.aborted || reject(e),
    );
  });
}

test("a new call rings the phone open; answering goes to the helper's plot and logs the call", async ({ page, server, api }) => {
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
  const call: InboxItem = {
    id: "merge-w1-1",
    kind: "merge",
    from: { kind: "session", id: "w1", name: "阿狐", agent: "fox" },
    who: "阿狐",
    text: "记住我做完了，看看能不能收",
    at: Date.now(),
    target: { kind: "session", id: "w1" },
    words: { label: "活熟了", title: "阿狐 做完了", body: "记住我做完了，看看能不能收", tray: "阿狐 做完了，可以收" },
  };
  const base: StateFrame = {
    ...frame,
    state: { ...frame.state, sessions: [session], issues: [{ ...made, sessions: ["w1"], status: "in_review", moves: ["done", "canceled"] }] },
    view: { ...frame.view, plots: { [made.id]: { crop: "wheat" } } },
  };
  let served = 0;
  await page.route("**/api/v1/state", (route) => {
    const next = served++ === 0 ? base : { ...base, inbox: [call] };
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(next)}\n\n` });
  });
  await openFarm(page);
  const phone = page.getByRole("region", { name: "农场手机" });
  await expect(phone.getByText("来电…")).toBeVisible({ timeout: 10_000 });
  await expect(phone.getByText("阿狐")).toBeVisible();
  await expect(phone.getByText("活熟了")).toBeVisible();
  await expect(page.getByRole("button", { name: "手机：来电" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("phone-ringing.png") });
  // Answering is the call to the assistant, the chat's call button's one.
  const calling = page.waitForRequest((r) => r.url().endsWith("/api/v1/voice/session") && r.method() === "POST");
  await phone.getByRole("button", { name: "接听" }).click();
  await calling;
  await expect(phone).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "阿狐的地" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "手机" }).click();
  await phone.getByRole("button", { name: "记录" }).click();
  await expect(phone.getByText("阿狐 · 活熟了")).toBeVisible();
  await expect(phone.getByText("接了")).toBeVisible();
  await phone.getByRole("button", { name: "未接 0" }).click();
  await expect(phone.getByText("没有未接来电。地里都好好的。")).toBeVisible();
});

test("calling the assistant on the phone is the chat's call: one call, the same answer", async ({ page }) => {
  await openFarm(page);
  await page.getByRole("button", { name: "手机" }).click();
  const phone = page.getByRole("region", { name: "农场手机" });
  await phone.getByRole("button", { name: "管家" }).click();
  await phone.getByRole("button", { name: "打给管家" }).click();
  // The test's server has no Agora credentials: the call does not get through, and both say why.
  await expect(phone.getByText(/没接通：还没有 Agora 的凭据/)).toBeVisible();
  await expect(page.getByRole("region", { name: "田头" }).getByRole("button", { name: "语音说话" })).toHaveAttribute(
    "title",
    /上次没接通：还没有 Agora 的凭据/,
  );
});
