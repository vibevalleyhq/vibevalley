// The workbench's issue page answers the owner's questions in order: what it is, where it stands, the one thing asked of
// the owner, how far it is. A helper on an issue is something tests cannot start (no runtime answers them), so each test
// serves a frame and the issue's history with one in place, the issue's standing as the server would say it.

import type { Page, Route } from "@playwright/test";
import type { Changes, Issue, IssueHistory, IssueStanding, IssueTimeline, Session, StateFrame } from "@vibevalley/protocol";
import { readStream, statePath } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

async function firstFrame(url: string): Promise<StateFrame> {
  const abort = new AbortController();
  return new Promise<StateFrame>((resolve, reject) => {
    readStream<StateFrame>(url + statePath, (f) => (resolve(f), abort.abort()), abort.signal).catch((e) => abort.signal.aborted || reject(e));
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
  standing: IssueStanding,
  more: Partial<Issue>,
  helper: Partial<Session>,
  timeline: IssueTimeline,
  changes: Changes = nothingYet,
) {
  const now = Date.now();
  const frame = await firstFrame(server.url);
  const session: Session = {
    id: "w1",
    name: "阿狐",
    agent: "fox",
    runtime: "nobody",
    brief: made.title,
    hiredAt: now - 10 * minute,
    runs: 1,
    phase: { _tag: "ripe" },
    issue: made.id,
    branch: "vibevalley/1",
    ...helper,
  };
  const closed = standing.state === "harvested" || standing.state === "closed";
  const issue: Issue = { ...made, sessions: ["w1"], project: "farm-site", standing, ...more };
  const fixture: StateFrame = { ...frame, state: { ...frame.state, sessions: closed ? [] : [session], issues: [issue] } };
  const history: IssueHistory[] = [
    { issue, sessions: [closed ? { ...session, phase: { _tag: "closed", at: now, closed: "merged" } } : session], missingSessions: [] },
  ];
  await page.route("**/api/v1/state", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(fixture)}\n\n` }),
  );
  await page.route("**/api/v1/issues/history", json(history));
  await page.route(`**/api/v1/issues/${made.id}/timeline`, json(timeline));
  await page.route(`**/api/v1/issues/${made.id}/changes`, json(changes));
  await page.route(`**/api/v1/issues/${made.id}/runs`, json([]));
  await page.route("**/api/v1/sessions/w1/events*", json([]));
  await page.goto(`/issues/${made.id}`);
  return page.getByRole("dialog", { name: "工单" });
}

const longJob = "通读 farm-site 项目，给主人一份整体架构和当前进度的评估。1）技术栈和代码量 2）模块和数据流 3）测试和构建现状 4）最该推进的三件事";

test("a helper waiting on a question: 等你回答, its options answer it, and nothing offers a harvest", async ({ page, server, api }) => {
  const made = await api.issue.create({ body: { title: longJob } });
  const now = Date.now();
  const view = await openIssue(
    page,
    server,
    made,
    { state: "asking", since: now - 3 * minute, lead: "answer", acts: ["answer", "close"] },
    {
      status: "in_review",
      asks: [{ question: "这份评估是全交给 w3，还是我和它分着做？", options: ["全交给 w3", "分着做"] }],
      criteria: ["技术栈和代码量", "模块和数据流", "测试和构建现状", "最该推进的三件事"],
    },
    { lastRun: { outcome: "completed", summary: "读完了结构，有一件事要问你", at: now - 3 * minute } },
    {
      milestones: [
        { at: now - 3 * minute, kind: "asked", who: "阿狐", text: "问你：这份评估是全交给 w3，还是我和它分着做？" },
        { at: now - 10 * minute, kind: "started", who: "阿狐", text: "开工" },
        { at: now - 12 * minute, kind: "opened", text: "开单" },
      ],
      spent: { tokens: 1200, cny: 0.42 },
    },
  );
  // The title is the first sentence, not the whole job.
  await expect(view.getByRole("heading", { name: "通读 farm-site 项目，给主人一份整体架构和当前进度的评估" })).toBeVisible();
  const status = view.getByLabel("现在怎样");
  await expect(status).toContainText("等你回答");
  await expect(status).toContainText("已经 3 分钟");
  await expect(status).toContainText("¥0.42");
  const ask = view.getByRole("region", { name: "要你做的" });
  await expect(ask.getByText("这份评估是全交给 w3，还是我和它分着做？")).toBeVisible();
  await expect(view.getByRole("button", { name: "收获" })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "验收通过" })).toHaveCount(0);
  await expect(view.getByRole("region", { name: "做到哪了" })).toContainText("0 / 4 条做到了");
  await expect(view.getByRole("region", { name: "做出了什么" })).toContainText("还没有改动");
  await expect(view.getByRole("region", { name: "怎么走到这一步" })).toContainText("问你：这份评估");
  await page.screenshot({ path: test.info().outputPath("asking.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ask.getByRole("button", { name: "分着做" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("asking-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });

  let said: unknown;
  await page.route(`**/api/v1/issues/${made.id}/comment`, async (route) => {
    said = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });
  await ask
    .getByRole("group", { name: /^回答：/ })
    .getByRole("button", { name: "分着做" })
    .click();
  await expect.poll(() => (said as { text?: string } | undefined)?.text).toBe("分着做");
});

test("work handed back: 等你验收, the helper's word on each criterion, and 打回 asks what failed", async ({ page, server, api }) => {
  const made = await api.issue.create({ body: { title: "把登录页的记住我做完" } });
  const now = Date.now();
  const view = await openIssue(
    page,
    server,
    made,
    { state: "reviewing", since: now - minute, lead: "accept", acts: ["accept", "reject", "tell", "close"] },
    {
      status: "in_review",
      acceptance: "required",
      criteria: ["勾上后重开浏览器还登着", "不勾时关掉浏览器就登出"],
      checks: [
        { criterion: 0, result: "met", proof: "bun test auth 通过" },
        { criterion: 1, result: "unsure", proof: "没法在测试里关浏览器" },
      ],
    },
    { lastRun: { outcome: "completed", summary: "做完了，commit abc123", at: now - minute } },
    { milestones: [{ at: now - minute, kind: "reported", who: "阿狐", text: "交回来了：做完了，commit abc123" }] },
    {
      ...nothingYet,
      commits: [{ hash: "abc123", subject: "记住我存 30 天", at: now - minute }],
      files: [{ path: "src/auth/login.ts", status: "M", added: 12, removed: 3 }],
    },
  );
  await expect(view.getByLabel("现在怎样")).toContainText("等你验收");
  const ask = view.getByRole("region", { name: "要你做的" });
  await expect(ask).toContainText("阿狐交回来了，等你验收");
  await expect(view.getByRole("region", { name: "做到哪了" })).toContainText("1 / 2 条做到了");
  await expect(view.getByText("bun test auth 通过")).toBeVisible();
  await expect(ask.getByRole("button", { name: "验收通过" })).toBeVisible();
  await expect(view.getByRole("button", { name: "收获" })).toHaveCount(0);
  await view.getByRole("checkbox", { name: "看过了：勾上后重开浏览器还登着" }).check();
  // Under load a click can land while the frame stream reconnects; 打回 is clicked until its box is there.
  const findings = ask.getByRole("textbox", { name: "哪里没过" });
  await expect(async () => {
    if (!(await findings.isVisible())) await ask.getByRole("button", { name: "打回", exact: true }).click({ timeout: 1000 });
    await expect(findings).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(ask.getByRole("button", { name: "打回，照上面修" })).toBeDisabled();
  await findings.fill("不勾时还登着");
  await expect(ask.getByRole("button", { name: "打回，照上面修" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("reviewing.png") });
});

test("a failed round: 卡住了, says why and leads with 接着修", async ({ page, server, api }) => {
  const made = await api.issue.create({ body: { title: "修好打卡页的夜间模式" } });
  const now = Date.now();
  const view = await openIssue(
    page,
    server,
    made,
    { state: "stuck", stuck: "failed", since: now - 5 * minute, lead: "cure", acts: ["cure", "tell", "close"] },
    { status: "in_review" },
    { phase: { _tag: "failed" }, lastRun: { outcome: "failed", summary: "余额不够了（HTTP 402）", at: now - 5 * minute } },
    { milestones: [{ at: now - 5 * minute, kind: "failed", who: "阿狐", text: "没做成：余额不够了（HTTP 402）" }] },
  );
  await expect(view.getByLabel("现在怎样")).toContainText("卡住了");
  const ask = view.getByRole("region", { name: "要你做的" });
  await expect(ask).toContainText("这一轮没做成");
  await expect(ask).toContainText("余额不够了（HTTP 402）");
  await expect(ask.getByRole("button", { name: "接着修" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("stuck.png") });
});

test("a harvested issue asks nothing: 收获了, and says it went into main", async ({ page, server, api }) => {
  const made = await api.issue.create({ body: { title: "给工单加上验收标准的模板" } });
  const now = Date.now();
  const view = await openIssue(
    page,
    server,
    made,
    { state: "harvested", since: now - 2 * minute, acts: ["reopen"] },
    { status: "done", closed: "merged", closedAt: now - 2 * minute, criteria: ["模板能选"], checks: [{ criterion: 0, result: "met" }] },
    {},
    {
      milestones: [
        { at: now - 2 * minute, kind: "closed", text: "收获了，合进了主分支" },
        { at: now - 4 * minute, kind: "reported", who: "阿狐", text: "交回来了" },
      ],
    },
  );
  await expect(view.getByLabel("现在怎样")).toContainText("收获了");
  await expect(view.getByRole("region", { name: "要你做的" })).toHaveCount(0);
  await expect(view.getByRole("region", { name: "做出了什么" })).toContainText("合进主分支");
  await expect(view.getByRole("region", { name: "做到哪了" })).toContainText("1 / 1 条做到了");
  await page.screenshot({ path: test.info().outputPath("harvested.png") });
});
