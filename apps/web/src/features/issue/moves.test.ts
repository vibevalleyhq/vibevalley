import { expect, test } from "vite-plus/test";

import type { AppliedIssue } from "@vibevalley/protocol";

import { testFrames } from "@/infra/testing";
import { bySeq, defineIntent, type Intent, intentsIn } from "@/state/intent";
import { frameAt, testRegistry } from "@/state/testing";

import type { BoardCard } from "./cards";
import { sampleIssue as issue } from "./issue.samples";
import { type IssueMove, issueMoveOf, movedCards, movedIssue, sendMove } from "./moves";

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

test("a move made off the board (a button on the issue's page) keeps the card in its lane, moving", () => {
  const [a] = [todo(1)];
  const offBoard: Intent<IssueMove, AppliedIssue> = { key: "k", input: { id: "i1", status: "backlog" }, status: "pending", queued: false };
  expect(movedCards([a], [offBoard])[0]).toMatchObject({ lane: "todo", move: { key: "k", state: "moving" } });
});

test("the issue's page shows the status moved to while it is on its way, and the frame's once it failed", () => {
  const i = issue(1, "第 1 件", "in_review", "medium");
  const going = move("i1", { input: { id: "i1", status: "canceled" } });
  expect(movedIssue(i, [going]).status).toBe("canceled");
  expect(movedIssue(i, [{ ...going, status: "failed", reason: "不行" }]).status).toBe("in_review");
  expect(issueMoveOf("i1", [going])).toEqual({ key: "k-i1", state: "moving" });
  expect(issueMoveOf("i2", [going])).toBeUndefined();
});

test("the same move again is the kept one, sent again with its key if it failed; another move lets it go", async () => {
  const frames = testFrames({ frame: frameAt(0) });
  const sent: string[] = [];
  const type = defineIntent<IssueMove, AppliedIssue>({
    send: (_m, key) => {
      sent.push(key);
      return Promise.reject(new Error("没连上"));
    },
    confirmed: bySeq,
    whileLost: "queue",
    timeoutMs: 1000,
  });
  const moves = intentsIn(testRegistry(frames), type);
  const first = sendMove(moves, { id: "i1", status: "done" });
  await first.done;
  const again = sendMove(moves, { id: "i1", status: "done" });
  await again.done;
  expect(again.key).toBe(first.key);
  expect(sent).toEqual([first.key, first.key]);
  const other = sendMove(moves, { id: "i1", status: "canceled" });
  await other.done;
  expect(moves.all().map((m) => m.key)).toEqual([other.key]);
});
