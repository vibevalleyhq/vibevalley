import { expect, test } from "vite-plus/test";

import type { AppliedIssue } from "@vibevalley/protocol";

import type { Intent } from "@/base/intent";

import type { BoardCard } from "./cards";
import { sampleIssue as issue } from "./issue.samples";
import { type IssueMove, movedCards } from "./moves";

const todo = (n: number): BoardCard => ({ kind: "todo", id: `i${n}`, lane: "todo", issue: issue(n, `第 ${n} 件`, "todo", "medium") });

const move = (id: string, over: Partial<Intent<IssueMove, AppliedIssue>> = {}): Intent<IssueMove, AppliedIssue> => ({
  key: `k-${id}`,
  input: { id, status: "todo", lane: "working" },
  status: "pending",
  queued: false,
  ...over,
});

test("a card on its way shows in the lane it was dropped on, moving, and nothing else of it changes", () => {
  const [a, b] = [todo(1), todo(2)];
  const shown = movedCards([a, b], [move("i1")]);
  expect(shown[0]).toEqual({ ...a, lane: "working", move: { key: "k-i1", state: "moving" } });
  // The issue is the frame's, status and all: the overlay sets the lane the owner chose and no more.
  expect(shown[0]?.kind === "todo" && shown[0].issue).toBe(a.kind === "todo" && a.issue);
  expect(shown[1]).toBe(b);
});

test("a failed move stays in sight with why, and a card with no move is the frame's", () => {
  const [a] = [todo(1)];
  expect(movedCards([a], [move("i1", { status: "failed", reason: "进行中满了" })])[0]?.move).toEqual({ key: "k-i1", state: "failed", reason: "进行中满了" });
  expect(movedCards([a], [])).toEqual([a]);
});

test("of two moves of one card, the newer is shown", () => {
  const [a] = [todo(1)];
  const older = move("i1", { key: "old", input: { id: "i1", status: "todo", lane: "working" } });
  const newer = move("i1", { key: "new", input: { id: "i1", status: "todo", lane: "todo" } });
  expect(movedCards([a], [older, newer])[0]).toMatchObject({ lane: "todo", move: { key: "new" } });
});
