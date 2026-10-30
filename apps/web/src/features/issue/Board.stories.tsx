import { createSignal } from "solid-js";

import type { Session } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { IssueBoard } from "./Board";
import type { BoardCard } from "./cards";
import type { Ordering } from "./display";
import { min, now, sampleIssue as issue, sampleSession as session, working } from "./issue.samples";

const sample = (): BoardCard[] => {
  const w = session("w1", "老周", working(now - 3 * min), { spent: { cny: 0.42 } as NonNullable<Session["spent"]> });
  const r = session("w2", "小林", { _tag: "resting" }, { lastRun: { outcome: "completed", summary: "登录过期回到登录页，加了两条测试。", at: now - 8 * min } });
  const d = session("w3", "老周", { _tag: "done" }, { hiredAt: now - 300 * min });
  return [
    { kind: "todo", id: "i21", lane: "todo", issue: issue(21, "写一句话就能起草工单", "backlog", "medium") },
    {
      kind: "todo",
      id: "i22",
      lane: "todo",
      issue: issue(22, "看板拖拽的手感", "todo", "high", { assignee: "老周", project: "vibevalley", queuedAt: now - 5 * min }),
    },
    { kind: "missing", id: "i23", lane: "todo", issue: issue(23, "灵动岛的动画", "todo", "low"), missing: ["项目"] },
    {
      kind: "issue",
      id: "i18",
      lane: "working",
      issue: issue(18, "修好登录", "in_progress", "urgent", { assignee: "老周" }),
      sessions: [w],
      tag: "working",
      session: w,
    },
    {
      kind: "issue",
      id: "i17",
      lane: "waiting",
      issue: issue(17, "补齐看板的测试", "in_review", "medium", { assignee: "小林" }),
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

export default stories({
  title: "界面/工单/看板",
  stories: {
    Board: story({
      fill: true,
      note: "四栏能拖；窄于 700 一次一栏、上面换栏（宽度换成 400 看）。卡片只标和这一栏默认不一样的。",
      args: { loading: false, ordering: "manual" },
      controls: { ordering: { kind: "choice", options: ["manual", "priority", "updated", "created"] } },
      render: (a) => {
        const [cards, setCards] = createSignal(sample());
        const [selected, setSelected] = createSignal<string>();
        let next = 30;
        return (
          <IssueBoard
            cards={cards()}
            loading={a.loading}
            selected={selected()}
            older={false}
            ordering={a.ordering as Ordering}
            onOlder={() => undefined}
            onOpen={setSelected}
            onDrop={(card, to) => setCards(cards().map((c) => (c.id === card.id ? { ...c, lane: to } : c)))}
            onPlace={() => undefined}
            onAdd={(text) => {
              const n = next++;
              setCards([{ kind: "todo", id: `i${n}`, lane: "todo", issue: issue(n, text, "backlog", "medium", { createdAt: now }) }, ...cards()]);
            }}
            onWrite={() => undefined}
          />
        );
      },
    }),
  },
});
