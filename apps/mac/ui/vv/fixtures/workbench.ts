// A busy workbench for tests, stories and the app's fake server
// (VIBEVALLEY_FAKE_SERVER=ui/vv/fixtures/workbench, written by fixtures.test.ts):
// the issues and helpers of VibeValley's Board story (issue.samples.ts),
// as a StateFrame and the answers of the reads the pages make.
import type { Agent, IssueHistory, Session, StateFrame } from "@vibevalley/protocol";

import { min, now, sampleIssue as issue, sampleSession as session, working } from "../web/features/issue/model/issue.samples";
import { responses as agentsResponses } from "./agents";
import { responses as artifactsResponses } from "./artifacts";
import { chatState, crons, responses as chatResponses } from "./chat";
import { responses as issuesResponses } from "./issues";
import { responses as memoryResponses } from "./memory";
import { responses as pixelResponses } from "./pixel";
import { responses as pkmResponses } from "./pkm";
import { connectors, responses as settingsResponses } from "./settings";

const w = session("w1", "laozhou", working(now - 3 * min), { name: "老周", spent: { tokens: 182_400, cny: 0.42 } });
const r = session(
  "w2",
  "xiaolin",
  { _tag: "resting" },
  { name: "小林", lastRun: { outcome: "completed", summary: "登录过期回到登录页，加了两条测试。", at: now - 8 * min } },
);
const d = session("w3", "laozhou", { _tag: "done" }, { name: "老周", hiredAt: now - 300 * min });

export const issues = [
  issue(21, "写一句话就能起草工单", "backlog", "medium"),
  // Startable: the server lists the moves an issue may make; the samples list none.
  { ...issue(22, "看板拖拽的手感", "todo", "high", { agent: "laozhou", repo: "vibevalley", queuedAt: now - 5 * min }), moves: ["todo"] },
  issue(23, "灵动岛的动画", "todo", "low"),
  issue(24, "首页的加载条", "todo", "medium", { agent: "xiaolin", repo: "vibevalley" }),
  issue(18, "修好登录", "in_progress", "urgent", { agent: "laozhou", repo: "vibevalley", sessionIds: [w.id] }),
  issue(17, "补齐看板的测试", "in_review", "medium", { agent: "xiaolin", repo: "vibevalley", sessionIds: [r.id] }),
  issue(12, "设置按用途分组", "done", "medium", { agent: "laozhou", repo: "vibevalley", sessionIds: [d.id], closedAt: now - 120 * min, delivered: "merged" }),
];

export const sessions = [w, r, d];

export const state: StateFrame = {
  seq: 1,
  state: { call: "live", callReason: "", sessions, issues, crons, chat: chatState, connectors, machines: [] } as unknown as StateFrame["state"],
  inbox: [],
  effects: [],
  view: { level: { level: 3, xp: 40, need: 300 }, plots: {}, plays: {}, achievements: [] },
};

const agent = (id: string, name: string): Agent =>
  ({ id, name, role: "worker", enabled: true, runtime: "claude", look: {}, description: "" }) as unknown as Agent;

/** `{ op: data }` as vibevalley_bridge::fake reads responses.json. */
export const responses: Record<string, unknown> = {
  "issue.history.list": issues.map(
    (i): IssueHistory =>
      ({
        issue: i,
        sessions: sessions.filter((s) => i.assignments.some((a) => a.executions.some((e) => e.session === s.id))),
        missingSessions: [],
      }) as unknown as IssueHistory,
  ),
  "agent.list": [agent("laozhou", "老周"), agent("xiaolin", "小林")],
  "agent.template.list": [],
  "repo.list": [],
  "runtime.list": [],
  ...issuesResponses,
  ...agentsResponses,
  ...chatResponses,
  ...settingsResponses,
  ...memoryResponses,
  ...pixelResponses,
  ...pkmResponses,
  ...artifactsResponses,
};
