import { expect, test } from "vite-plus/test";

import type { IssueHistory, WorkspaceView } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { sampleIssue as issue, sampleSession as session } from "./issue.samples";
import { boardRows, historyKey } from "./rows";

const core = (over: Partial<WorkspaceView>): WorkspaceView => ({
  call: "idle",
  callReason: "",
  sessions: [],
  issues: [],
  orchestrators: {},
  crons: [],
  connectors: [],
  ...over,
});

const gone = session("s1", "老周", { _tag: "done" });
const here = session("s2", "小林", { _tag: "resting" });

test("an issue the frame keeps is the frame's, with its sessions from the farm or the history", () => {
  const live = issue(1, "修好登录", "in_review", "medium", { sessions: [sessionId("s1"), sessionId("s2")] });
  const read: IssueHistory[] = [{ issue: { ...live, title: "旧标题" }, sessions: [gone], missingSessions: [] }];
  expect(boardRows(core({ issues: [live], sessions: [here] }), read, false)).toEqual([{ issue: live, sessions: [gone, here], missingSessions: [] }]);
});

test("the older closed issues come from the history only with 更早的, and nothing before the first frame", () => {
  const live = issue(1, "开着的", "todo", "medium");
  const old = issue(2, "早就关了", "done", "medium");
  const read: IssueHistory[] = [
    { issue: live, sessions: [], missingSessions: [] },
    { issue: old, sessions: [], missingSessions: [] },
  ];
  expect(boardRows(core({ issues: [live] }), read, false)?.map((r) => r.issue.id)).toEqual(["i1"]);
  expect(boardRows(core({ issues: [live] }), read, true)?.map((r) => r.issue.id)).toEqual(["i1", "i2"]);
  expect(boardRows(undefined, read, true)).toBeUndefined();
});

test("a session that left after the history was read is the one the frame last had", () => {
  const live = issue(1, "修好登录", "in_review", "medium", { sessions: [sessionId("s1")] });
  expect(boardRows(core({ issues: [live] }), [], false, new Map([["s1", gone]]))?.[0]?.sessions).toEqual([gone]);
});

test("the history is read again when an issue gets a session or one leaves the farm, not when an issue moves", () => {
  const a = issue(1, "a", "todo", "medium");
  const before = historyKey(core({ issues: [a] }));
  expect(historyKey(core({ issues: [{ ...a, status: "in_progress", title: "b" }] }))).toBe(before);
  expect(historyKey(core({ issues: [{ ...a, sessions: [sessionId("s2")] }], sessions: [here] }))).not.toBe(before);
  expect(historyKey(core({ issues: [{ ...a, sessions: [sessionId("s2")] }] }))).not.toBe(
    historyKey(core({ issues: [{ ...a, sessions: [sessionId("s2")] }], sessions: [here] })),
  );
});
