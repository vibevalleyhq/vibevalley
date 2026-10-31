// The farm phone (src/farm/phone): it opens over its button, a game takes the pad and its keys, Esc puts it away; a
// new call in the inbox rings it open, and answering goes to what called. The call needs a helper and an inbox item,
// which tests cannot make, so that test serves frames in place of the state stream: the stream ends after each, and
// the page reconnects a second later to the next.

import type { Page } from "@playwright/test";

import type { InboxItem, StateFrame, SessionView } from "@vibevalley/protocol";
import { readStream, statePath, pathOf } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

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
  await page.getByTestId("phone-button").click();
  const phone = page.getByTestId("phone");
  await expect(phone).toHaveAttribute("data-screen", "home");
  // The pad shows only while a game takes it.
  await expect(phone.getByTestId("pad")).toHaveCount(0);
  await phone.locator('[data-key="games"]').click();
  await phone.locator('[data-key="blocks"]').click();
  const blocks = phone.getByTestId("blocks");
  await expect(blocks).toHaveAttribute("data-state", "ready");
  await expect(phone.getByTestId("pad")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(blocks).toHaveAttribute("data-state", "playing");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("x");
  await expect(blocks).toHaveAttribute("data-state", "paused");
  // Home from a game is the games folder.
  await phone.getByTestId("phone-home").click();
  await expect(phone).toHaveAttribute("data-screen", "games");
  await phone.locator('[data-key="merge"]').click();
  await page.keyboard.press("Enter");
  await expect(phone.getByTestId("merge-board")).toHaveAttribute("data-count", "2");
  await page.keyboard.press("Escape");
  await expect(phone).toHaveCount(0);
  await expect(page.getByTestId("menu")).toHaveCount(0);
});

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream(url, statePath, (f) => (resolve(f), abort.signal.aborted || abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

test("a new call rings the phone open; answering goes to the helper's plot and logs the call", async ({ page, server, api }) => {
  const made = await api.issue.create({ title: "finish remember-me on the login page" });
  const frame = await firstFrame(server.url);
  const session: SessionView = {
    id: sessionId("w1"),
    name: "fox",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: Date.now() - 600_000,
    runs: 1,
    phase: { _tag: "done" },
    refining: false,
    phaseText: "",
    issue: made.id,
    lastRun: { outcome: "completed", summary: "done, tests pass", at: Date.now() - 60_000 } as never,
    play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
  };
  const call: InboxItem = {
    id: "merge-w1-1",
    kind: "review",
    from: { kind: "session", id: "w1", name: "fox", agent: "fox" },
    who: "fox",
    text: "remember-me is done, see if it can go in",
    at: Date.now(),
    target: { kind: "session", id: "w1" },
    words: { label: "for you", title: "fox is done", body: "remember-me is done", tray: "fox is done" },
  };
  const base: StateFrame = {
    ...frame,
    state: { ...frame.state, sessions: [session], issues: [{ ...made, sessions: [sessionId("w1")], status: "in_review", moves: ["done", "canceled"] }] },
    view: { ...frame.view, plots: { [made.id]: { crop: "wheat" } } },
  };
  let served = 0;
  await page.route("**/api/v1/state", (route) => {
    const next = served++ === 0 ? base : { ...base, inbox: [call] };
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(next)}\n\n` });
  });
  await openFarm(page);
  const phone = page.getByTestId("phone");
  await expect(phone).toHaveAttribute("data-screen", "ringing", { timeout: 10_000 });
  await expect(phone.getByTestId("ringing")).toHaveAttribute("data-key", call.id);
  await expect(page.getByTestId("phone-button")).toHaveAttribute("data-state", "ringing");
  // Answering is the call to the orchestrator, the chat's call button's one.
  const calling = page.waitForRequest((r) => r.url().endsWith(pathOf("voice.grant.create")) && r.method() === "POST");
  await phone.getByTestId("answer").click();
  await calling;
  // The call is on the phone, unfolded to the chat where what is said shows; what called opens beside it.
  const chat = page.getByTestId("farm-chat");
  await expect(chat).toBeVisible();
  await expect(page.getByTestId("plot")).toBeVisible();
  // Esc closes what called first (the phone leaves an open dialog its Esc), then the phone goes away by its button.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("plot")).toHaveCount(0);
  await expect(chat).toBeVisible();
  await page.getByTestId("phone-button").click();
  await expect(phone).toHaveCount(0);
  await page.getByTestId("phone-button").click();
  await phone.locator('[data-key="log"]').click();
  await expect(phone.locator(`[data-testid="call-log"][data-key="${call.id}"]`)).toHaveAttribute("data-answered", "");
  await phone.locator('[data-key="missed"]').click();
  await expect(phone.getByTestId("calls-empty")).toBeVisible();
});

// Tapping the orchestrator on the phone dials it: its line beside the chat, unfolded; a call started folded unfolds it,
// where what is said shows.
test("calling the orchestrator on the phone is the chat's call: one call, the same answer", async ({ page }) => {
  await openFarm(page);
  await page.getByTestId("phone-button").click();
  const phone = page.getByTestId("phone");
  const chat = page.getByTestId("farm-chat");
  const dialed = page.waitForRequest((r) => r.url().endsWith(pathOf("voice.grant.create")) && r.method() === "POST");
  await phone.locator('[data-key="orchestrator"]').click();
  await dialed;
  await expect(chat).toBeVisible();
  // The test's server has no Agora credentials: the call does not get through, and both say why.
  const line = phone.getByTestId("orchestrator-line");
  await expect(line).toHaveAttribute("data-problem", "");
  await page.keyboard.press("Escape");
  await expect(chat).toHaveCount(0);
  // After a call that did not get through, the line's own key tries again, and unfolds the phone as it does.
  const again = page.waitForRequest((r) => r.url().endsWith(pathOf("voice.grant.create")) && r.method() === "POST");
  await line.getByTestId("line-key").click();
  await again;
  await expect(chat).toBeVisible();
  await expect(line).toHaveAttribute("data-state", "idle");
  await expect(line).toHaveAttribute("data-problem", "");
  // The chat says why too, with the way to the setting that fixes it.
  await chat.getByTestId("call-problem").getByTestId("call-problem-fix").click();
  await expect(page).toHaveURL(/\/settings\/call$/u);
});
