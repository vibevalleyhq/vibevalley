// VibeValley's Board story (apps/web/src/features/issue/views/Board.stories.tsx), same sample.
import type { Session } from "@vibevalley/protocol";

import type { BoardCard } from "../web/features/issue/model/cards";
import { min, now, sampleIssue as issue, sampleSession as session, working } from "../web/features/issue/model/issue.samples";
import { IssueBoard } from "../web/features/issue/views/Board";

export const sample = (): BoardCard[] => {
  const w = session("w1", "老周", working(now - 3 * min), { spent: { cny: 0.42 } as NonNullable<Session["spent"]> });
  const r = session("w2", "小林", { _tag: "resting" }, { lastRun: { outcome: "completed", summary: "登录过期回到登录页，加了两条测试。", at: now - 8 * min } });
  const d = session("w3", "老周", { _tag: "done" }, { hiredAt: now - 300 * min });
  return [
    { kind: "todo", id: "i21", lane: "todo", issue: issue(21, "写一句话就能起草工单", "backlog", "medium") },
    {
      kind: "todo",
      id: "i22",
      lane: "todo",
      issue: issue(22, "看板拖拽的手感", "todo", "high", { agent: "老周", repo: "vibevalley", queuedAt: now - 5 * min }),
    },
    { kind: "missing", id: "i23", lane: "todo", issue: issue(23, "灵动岛的动画", "todo", "low"), missing: ["仓库"] },
    {
      kind: "todo",
      id: "i24",
      lane: "working",
      issue: issue(24, "首页的加载条", "todo", "medium", { agent: "小林", repo: "vibevalley" }),
      move: { key: "k24", state: "moving" },
    },
    {
      kind: "todo",
      id: "i25",
      lane: "working",
      issue: issue(25, "换一个更短的标题", "todo", "medium", { agent: "小林", repo: "vibevalley" }),
      move: { key: "k25", state: "failed", reason: "进行中满了：同时最多 3 件" },
    },
    {
      kind: "issue",
      id: "i18",
      lane: "working",
      issue: issue(18, "修好登录", "in_progress", "urgent", { agent: "老周", sessionIds: [w.id] }),
      sessions: [w],
      tag: "working",
      session: w,
    },
    {
      kind: "issue",
      id: "i17",
      lane: "waiting",
      issue: issue(17, "补齐看板的测试", "in_review", "medium", { agent: "小林", sessionIds: [r.id] }),
      sessions: [r],
      tag: "waiting",
      session: r,
    },
    {
      kind: "issue",
      id: "i12",
      lane: "closed",
      issue: issue(12, "设置按用途分组", "done", "medium", { closedAt: now - 120 * min, delivered: "merged" }),
      sessions: [d],
      tag: "closed",
    },
  ];
};

export function BoardStory(props: { loading?: boolean }) {
  return (
    <IssueBoard
      cards={sample()}
      loading={props.loading ?? false}
      older={false}
      ordering="manual"
      onOlder={() => {}}
      onOpen={() => {}}
      onDrop={() => {}}
      onRetry={() => {}}
      onPutBack={() => {}}
      onPlace={() => {}}
      onNew={() => {}}
    />
  );
}
