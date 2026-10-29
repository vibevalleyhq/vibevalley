// The workbench's issue page answers the owner's questions in order: what it is, where it stands, the one thing asked of
// the owner, how far it is. The first test sends a real helper (the server's scripted runtime, doing what its job's
// words say); the rest serve a frame and the issue's history with one in place, for states it does not reach.

import type { Page, Route } from "@playwright/test";
import type { Agent, Changes, Issue, IssueHistory, IssueAttention, IssueTimeline, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath, pathOf } from "@vibevalley/protocol";
import { buttons, expect, test } from "./fixtures";
import { sessionId } from "@vibevalley/protocol/schema";

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream(url, statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
  });
}

const json = (body: unknown) => (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const minute = 60_000;

const nothingYet: Changes = { project: "farm-site", base: "main", branch: "vibevalley/1", commits: [], files: [], uncommitted: [], conflicts: [], behind: 0 };

/** Serves the issue (as the server would have it with `more`) and its helper, and opens its page. */
async function openIssue(
  page: Page,
  server: { url: string },
  made: Issue,
  attention: IssueAttention,
  more: Partial<Issue>,
  helper: Partial<Session>,
  timeline: IssueTimeline,
  changes: Changes = nothingYet,
) {
  const now = Date.now();
  const frame = await firstFrame(server.url);
  const session: Session = {
    id: sessionId("w1"),
    name: "阿狐",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: now - 10 * minute,
    runs: 1,
    phase: { _tag: "done" },
    refining: false,
    issue: made.id,
    branch: "vibevalley/1",
    ...helper,
  };
  const closed = attention.state === "done" || attention.state === "canceled";
  const issue: Issue = { ...made, sessions: [sessionId("w1")], project: "farm-site", attention, ...more };
  const fixture: StateFrame = { ...frame, state: { ...frame.state, sessions: closed ? [] : [session], issues: [issue] } };
  const history: IssueHistory[] = [
    { issue, sessions: [closed ? { ...session, phase: { _tag: "closed", at: now, closed: "merged" } } : session], missingSessions: [] },
  ];
  await page.route("**/api/v1/state", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(fixture)}\n\n` }),
  );
  await page.route(`**${pathOf("issue.history.list")}`, json(history));
  await page.route(`**${pathOf("issue.timeline.get")}`, json(timeline));
  await page.route(`**${pathOf("issue.diff.get")}`, json(changes));
  await page.route(`**${pathOf("issue.run.list")}`, json([]));
  await page.route(`**${pathOf("session.event.list")}`, json([]));
  await page.goto(`/issues/${made.id}`);
  return page.getByTestId("issue");
}

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

// The test helper's words (apps/server/src/testing/helper.ts): 先问清楚 asks which port, 给选项 with options, and the
// answer 用 8797 lets it go on and hand back.
const asksWithOptions = "打卡页先问清楚，给选项";
const answer = "用 8797";

test("a real round: the helper asks with options, one click answers, and it hands back with its word on each criterion", async ({ page, api }) => {
  const fox = await api.agent.create(scripted);
  const project = await api.project.create({ name: "clock" });
  const made = await api.issue.create({ title: asksWithOptions, project: project.name, assignee: fox.id });
  await api.issue.update({ id: made.id, criteria: ["clock-in works"] });
  await api.issue.status.update({ id: made.id, status: "todo" });
  await page.goto(`/issues/${made.id}`);
  const view = page.getByTestId("issue");
  const now = view.getByTestId("issue-now");
  await expect(now).toHaveAttribute("data-state", "asking", { timeout: 20_000 });
  await view.getByTestId("issue-ask").locator(`[data-testid="answer-option"][data-key="${answer}"]`).click();
  await expect(now).toHaveAttribute("data-state", "reviewing", { timeout: 20_000 });
  const progress = view.getByTestId("issue-progress");
  await expect(progress).toHaveAttribute("data-met", "1");
  await expect(progress).toHaveAttribute("data-total", "1");
  await expect(view.getByTestId("issue-ask").locator('[data-act="complete"]')).toBeVisible();
  await expect(view.getByTestId("issue-deliver")).toHaveAttribute("data-value", "change");
  await expect(view.getByTestId("issue-story").locator('[data-testid="milestone"][data-kind="told"]').first()).toBeVisible();
});

test("a helper waiting on a question: its options answer it, and nothing offers to complete it", async ({ page, server, api }) => {
  const made = await api.issue.create({ title: "assess the farm-site project" });
  const now = Date.now();
  const options = ["all to w3", "split it"];
  const view = await openIssue(
    page,
    server,
    made,
    { state: "asking", since: now - 3 * minute, lead: "answer", acts: buttons("answer", "close") },
    { status: "in_review", questions: [{ question: "all to w3, or split?", options }], criteria: ["stack", "modules", "tests", "next"] },
    { lastRun: { outcome: "completed", summary: "one thing to ask", at: now - 3 * minute } },
    { milestones: [{ at: now - 3 * minute, kind: "asked", who: "fox", text: "asked" }], spent: { tokens: 1200, cny: 0.42 } },
  );
  await expect(view.getByTestId("issue-now")).toHaveAttribute("data-state", "asking");
  await expect(view.locator('[data-act="complete"]')).toHaveCount(0);
  await expect(view.getByTestId("issue-progress")).toHaveAttribute("data-met", "0");
  let said: unknown;
  await page.route(`**${pathOf("issue.comment.create")}`, async (route) => {
    said = route.request().postDataJSON();
    await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(made) });
  });
  await view.locator(`[data-testid="answer-option"][data-key="${options[1]}"]`).click();
  await expect.poll(() => said as { text?: string } | undefined).toMatchObject({ text: options[1] });
});

test("work handed back: the server's acts lead, and sending it back needs what failed", async ({ page, server, api }) => {
  const made = await api.issue.create({ title: "finish remember-me" });
  const now = Date.now();
  const view = await openIssue(
    page,
    server,
    made,
    { state: "reviewing", since: now - minute, lead: "complete", acts: buttons("complete", "reject", "tell", "close") },
    {
      status: "in_review",
      criteria: ["still logged in after reopening", "logged out when unticked"],
      checks: [
        { criterion: 0, result: "met", proof: "auth tests pass" },
        { criterion: 1, result: "unsure", proof: "cannot close a browser in a test" },
      ],
    },
    { lastRun: { outcome: "completed", summary: "done, commit abc123", at: now - minute } },
    { milestones: [{ at: now - minute, kind: "reported", who: "fox", text: "handed back" }] },
    {
      ...nothingYet,
      commits: [{ hash: "abc123", subject: "remember for 30 days", at: now - minute }],
      files: [{ path: "src/auth/login.ts", status: "M", added: 12, removed: 3 }],
    },
  );
  await expect(view.getByTestId("issue-now")).toHaveAttribute("data-state", "reviewing");
  await expect(view.getByTestId("issue-progress")).toHaveAttribute("data-met", "1");
  const ask = view.getByTestId("issue-ask");
  for (const act of ["complete", "reject", "tell"]) await expect(ask.locator(`[data-act="${act}"]`)).toBeVisible();
  await view.locator('[data-testid="criterion-tick"][data-key="0"]').check();
  const reject = ask.locator('[data-act="reject"]');
  await reject.click();
  const words = ask.getByTestId("issue-words");
  await expect(words).toHaveAttribute("data-box", "reject");
  await expect(reject).toBeDisabled();
  await words.fill("still logged in when unticked");
  await expect(reject).toBeEnabled();
});
