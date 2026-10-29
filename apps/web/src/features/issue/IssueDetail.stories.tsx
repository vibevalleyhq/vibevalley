import type { Changes, Issue, SessionView } from "@vibevalley/protocol";
import { stories, story, type Story } from "@vibevalley/stories";
import { answer } from "@/base/storyApi";
import { ToastHost } from "@/ui/ToastHost";
import { AnswerView, IssueDetail } from "./IssueDetail";
import { TodoDetail } from "./TodoDetail";
import { acts, min, now, sampleChanges, sampleIssue, sampleSession, working } from "./issue.samples";
import { omitUndefined } from "@vibevalley/protocol/rules";

const description = "过期的会话现在报错，页面一直转圈。\n\n要做的：过期就回到登录页，说清楚为什么。";
const criteria = ["过期的会话回到登录页", "登录页说「登录过期了」", "补一条跨过期限的测试"];

interface Page {
  readonly note: string;
  readonly issue: Issue;
  readonly sessions?: SessionView[];
  readonly session?: SessionView;
  readonly changes?: Changes;
}

const resting = (more: Partial<SessionView> = {}) =>
  sampleSession("w1", "老周", { _tag: "resting" }, { project: "vibevalley", branch: "issue-18-login", runs: 3, ...more });

const lastRun = (outcome: "completed" | "failed" | "interrupted", summary: string) => ({ outcome, summary, at: now - 6 * min });

const base = (more: { [K in keyof Issue]?: Issue[K] | undefined }) =>
  sampleIssue(
    18,
    "修好登录过期",
    "in_review",
    "high",
    omitUndefined({ description, criteria, project: "vibevalley", assignee: "老周", sessions: [], ...more }),
  );

// Each state as the server sends it; the buttons follow apps/server/src/issue/attention.ts.
const pages: Record<string, Page> = {
  草稿: {
    note: "写下来还没派：主动作是开始。",
    issue: base({
      status: "backlog",
      assignee: undefined,
      attention: { state: "draft", since: now - 20 * min, lead: "start", acts: [acts.start, acts.close] },
    }),
  },
  排队: {
    note: "派了，等一个空位。",
    issue: base({ status: "todo", queuedAt: now - 3 * min, attention: { state: "queued", since: now - 3 * min, acts: [acts.close] } }),
  },
  在做: (() => {
    const s = sampleSession("w1", "老周", working(now - 4 * min), { project: "vibevalley", branch: "issue-18-login" });
    return {
      note: "帮工在干：能说一句、叫停或关掉。",
      issue: base({ status: "in_progress", sessions: [s.id], attention: { state: "working", since: now - 4 * min, acts: [acts.tell, acts.stop, acts.close] } }),
      sessions: [s],
      session: s,
    };
  })(),
  没动静: (() => {
    const s = sampleSession("w1", "老周", working(now - 30 * min, now - 12 * min), { project: "vibevalley", branch: "issue-18-login" });
    return {
      note: "在做，可是十几分钟没动静：主动作是叫停。",
      issue: base({
        status: "in_progress",
        sessions: [s.id],
        attention: { state: "stuck", stuck: "quiet", since: now - 12 * min, lead: "stop", acts: [acts.stop, acts.tell, acts.close] },
      }),
      sessions: [s],
      session: s,
    };
  })(),
  在问: (() => {
    const s = resting({ lastRun: lastRun("completed", "两种做法，要你挑一个。") });
    return {
      note: "帮工有问题要你答：主动作是回答。",
      issue: base({
        sessions: [s.id],
        questions: [{ question: "过期以后回登录页，还是原地弹一个登录框？", options: ["回登录页", "原地弹框"] }],
        attention: { state: "asking", since: now - 6 * min, lead: "answer", acts: [acts.answer, acts.close] },
      }),
      sessions: [s],
      session: s,
    };
  })(),
  等你看: (() => {
    const s = resting({ lastRun: lastRun("completed", "过期回到登录页，登录页说明原因，加了两条测试。") });
    return {
      note: "交活了：看改动和验收标准，完成或打回。",
      issue: base({
        sessions: [s.id],
        checks: [
          { criterion: 0, result: "met", proof: "session.test.ts 覆盖了" },
          { criterion: 1, result: "met", proof: "" },
          { criterion: 2, result: "unsure", proof: "只测了过期前后各一秒" },
        ],
        attention: { state: "reviewing", since: now - 6 * min, lead: "complete", acts: [acts.complete, acts.reject, acts.tell, acts.close] },
      }),
      sessions: [s],
      session: s,
      changes: sampleChanges,
    };
  })(),
  没做成: (() => {
    const s = resting({ lastRun: lastRun("failed", "测试起不来：缺一个环境变量。") });
    return {
      note: "这一轮失败了：主动作是补救。",
      issue: base({
        sessions: [s.id],
        findings: [{ id: "f1", text: "登录页的文案没改", at: now - 30 * min, resolved: false }],
        attention: { state: "stuck", stuck: "failed", since: now - 6 * min, lead: "cure", acts: [acts.cure, acts.tell, acts.close] },
      }),
      sessions: [s],
      session: s,
    };
  })(),
  有冲突: (() => {
    const s = resting({
      lastRun: lastRun("completed", "做完了，但主分支动了同一个文件。"),
      conflict: { base: "main", files: ["apps/web/src/base/session.ts"] },
    });
    return {
      note: "和主分支冲突：主动作是解决。",
      issue: base({
        sessions: [s.id],
        attention: { state: "stuck", stuck: "conflict", since: now - 6 * min, lead: "resolve", acts: [acts.resolve, acts.tell, acts.close] },
      }),
      sessions: [s],
      session: s,
      changes: { ...sampleChanges, conflicts: ["apps/web/src/base/session.ts"] },
    };
  })(),
  完成: (() => {
    const s = sampleSession(
      "w1",
      "老周",
      { _tag: "done" },
      { project: "vibevalley", branch: "issue-18-login", lastRun: lastRun("completed", "合进了 main。") },
    );
    return {
      note: "合进了主分支；还能重开。",
      issue: base({
        status: "done",
        sessions: [s.id],
        closedAt: now - 60 * min,
        delivered: "merged",
        attention: { state: "done", since: now - 60 * min, acts: [acts.reopen] },
      }),
      sessions: [s],
      changes: sampleChanges,
    };
  })(),
  关了: {
    note: "不做了；主动作是重开。",
    issue: base({
      status: "canceled",
      canceled: "dismissed",
      closedAt: now - 90 * min,
      attention: { state: "canceled", since: now - 90 * min, lead: "reopen", acts: [acts.reopen] },
    }),
  },
};

const pageStory = (p: Page): Story =>
  story({
    fill: true,
    note: p.note,
    render: () => {
      answer({
        "issue/diff/get": () => p.changes ?? { ...sampleChanges, commits: [], files: [] },
        "issue/timeline/get": () => ({ milestones: [] }),
        "issue/run/list": () => [],
        "session/event/list": () => [],
        "artifact/list": () => [],
      });
      return (
        <div class="flex flex-col">
          {/* As the issues page does: one never sent to a helper opens as a draft to write and send. */}
          {p.sessions === undefined ? (
            <TodoDetail item={p.issue} onDone={() => undefined} />
          ) : (
            <IssueDetail issue={p.issue} sessions={p.sessions} session={p.session} onClose={() => undefined} />
          )}
          <ToastHost />
        </div>
      );
    },
  });

export default stories({
  title: "界面/工单/工单页",
  stories: {
    ...Object.fromEntries(Object.entries(pages).map(([name, p]) => [name, pageStory(p)])),
    答案: story({
      note: "只要答案的工单交回来的样子：结论、依据、拿不准的、下一步。",
      render: () => (
        <div class="w-full max-w-xl">
          <AnswerView
            answer={{
              conclusion: "登录过期是因为 cookie 的有效期比服务端的会话短一个小时。",
              evidence: ["session.ts 里 cookie 的 maxAge 是 23 小时", "服务端的会话是 24 小时"],
              unsure: ["手机壳里的 WebView 是不是另存了一份"],
              next: ["把两边对齐成同一个常量", "补一条跨过边界的测试"],
            }}
          />
        </div>
      ),
    }),
  },
});
