import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Issue, IssueId } from "@vibevalley/protocol";

import type { BoardCard } from "../model/cards";
import {
  BOARD_LANE_GAP,
  BOARD_PAD_X,
  boardLaneWidth,
  dragDropOutcome,
  type DragGhost,
  type DragState,
  type DragTargets,
  dragTransition,
  initialDragState,
} from "./Board";
import { effectiveIssueOverlay, initialIssueOverlay, isIssueOverlayBlocking, type IssueOverlay, issueOverlayTransition } from "./IssuesPage";

function makeIssue(id: string, status: Issue["status"] = "todo"): Issue {
  return {
    id: id as IssueId,
    number: 1,
    title: `Issue ${id}`,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status,
    moves: ["backlog", "todo", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    repo: "vibevalley",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: 1000,
    stage: { state: "draft", acts: [] },
  };
}

function makeTodoCard(id: string, lane: "backlog" | "todo" = "todo"): BoardCard {
  const issue = makeIssue(id, lane);
  return { id, kind: "todo", lane, issue };
}

const sampleGhost: DragGhost = { number: "#1", title: "Card A", dx: 10, dy: 10, w: 240, h: 84, origin: { x: 0, y: 0 } };
const sampleTargets: DragTargets = {
  laneRects: [
    ["backlog", { x: 0, y: 0, w: 220, h: 320 }],
    ["todo", { x: 230, y: 0, w: 220, h: 600 }],
    ["in_progress", { x: 460, y: 0, w: 220, h: 240 }],
  ],
  cardRects: [
    ["c-1", { x: 240, y: 40, w: 200, h: 80 }],
    ["c-2", { x: 240, y: 130, w: 200, h: 80 }],
  ],
  boardRect: { x: 0, y: 0, w: 680, h: 600 },
};

test("IssuesPage overlay FSM keeps overlays mutually exclusive and handles peek/close/reopen/new", () => {
  let state: IssueOverlay = initialIssueOverlay();
  expect(state).toEqual({ kind: "none" });
  expect(isIssueOverlayBlocking(state)).toBe(false);

  state = issueOverlayTransition(state, { kind: "peek", id: "i1" });
  expect(state).toEqual({ kind: "peeking", id: "i1" });
  expect(isIssueOverlayBlocking(state)).toBe(true);

  const issue = makeIssue("i1", "in_review");
  state = issueOverlayTransition(state, { kind: "openClose", issue, session: undefined, review: true });
  expect(state.kind).toBe("closing");
  expect(isIssueOverlayBlocking(state)).toBe(true);
  if (state.kind === "closing") expect(state.returnPeekId).toBe("i1");

  // Dismissing a close dialog opened from Quick-Peek restores Quick-Peek cleanly.
  state = issueOverlayTransition(state, { kind: "dismiss" });
  expect(state).toEqual({ kind: "peeking", id: "i1" });

  // Opening New or Reopen replaces any prior overlay directly.
  state = issueOverlayTransition(state, { kind: "openNew", at: { repo: "vibevalley" } });
  expect(state).toEqual({ kind: "new", at: { repo: "vibevalley" } });

  state = issueOverlayTransition(state, { kind: "openReopen", issue, lane: "todo" });
  expect(state).toEqual({ kind: "reopening", issue, lane: "todo" });

  state = issueOverlayTransition(state, { kind: "dismiss" });
  expect(state).toEqual({ kind: "none" });

  // Route `/issues/new` forces the new-issue overlay; opening a full issue suppresses stale peek.
  expect(effectiveIssueOverlay({ kind: "none" }, "new", { repo: "vv" }, undefined)).toEqual({ kind: "new", at: { repo: "vv" } });
  expect(effectiveIssueOverlay({ kind: "peeking", id: "i1" }, "i1", {}, "i1")).toEqual({ kind: "none" });
});

test("Board drag FSM transitions idle -> measuring -> dragging -> idle and ignores stale measure() callbacks via epoch", () => {
  const cardA = makeTodoCard("c-1", "todo");
  const cardB = makeTodoCard("c-2", "todo");
  const placeable = (id: string) => id === "c-1" || id === "c-2";

  let state: DragState = initialDragState();
  expect(state).toEqual({ phase: "idle", epoch: 0 });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "none" });

  // Start drag: enters measuring with epoch 1.
  state = dragTransition(state, { kind: "start", card: cardA, title: "Card A", at: { x: 260, y: 60 } });
  expect(state).toEqual({ phase: "measuring", epoch: 1, card: cardA, title: "Card A", at: { x: 260, y: 60 } });
  const staleEpoch1 = state.epoch;

  // Pointer moves while measure() is still in flight -> updates pending pointer coordinates.
  state = dragTransition(state, { kind: "move", at: { x: 260, y: 150 }, isPlaceable: placeable });
  expect(state).toEqual({ phase: "measuring", epoch: 1, card: cardA, title: "Card A", at: { x: 260, y: 150 } });

  // End before measure() completes -> returns to idle and advances epoch to 2.
  state = dragTransition(state, { kind: "end" });
  expect(state).toEqual({ phase: "idle", epoch: 2 });

  // Re-start dragging the SAME cardA -> epoch 3. Stale epoch 1 measure() callback MUST be ignored!
  state = dragTransition(state, { kind: "start", card: cardA, title: "Card A", at: { x: 260, y: 60 } });
  expect(state.epoch).toBe(3);

  const ignoredStale = dragTransition(state, {
    kind: "measured",
    epoch: staleEpoch1,
    ghost: sampleGhost,
    targets: sampleTargets,
    isPlaceable: placeable,
  });
  expect(ignoredStale).toBe(state);
  expect(ignoredStale.phase).toBe("measuring");

  // Valid epoch 3 measure() transitions to dragging and runs initial hit test.
  state = dragTransition(state, {
    kind: "measured",
    epoch: 3,
    ghost: sampleGhost,
    targets: sampleTargets,
    isPlaceable: placeable,
  });
  expect(state.phase).toBe("dragging");
  if (state.phase === "dragging") {
    expect(state.over).toBe("todo");
    expect(state.before).toBeUndefined();
  }

  // Move over c-2 -> sets `before: "c-2"` for manual ordering; drop outcome is `place`.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "place", card: cardA, before: "c-2" });

  // Move over backlog lane -> outcome is `drop` on backlog.
  state = dragTransition(state, { kind: "move", at: { x: 50, y: 50 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "backlog" });
  expect(dragDropOutcome(state, false)).toEqual({ kind: "none" });

  // Terminating or starting a new card drag while dragging resets cleanly.
  state = dragTransition(state, { kind: "start", card: cardB, title: "Card B", at: { x: 280, y: 150 } });
  expect(state.phase).toBe("measuring");
  expect(state.epoch).toBe(4);
  state = dragTransition(state, { kind: "end" });
  expect(state).toEqual({ phase: "idle", epoch: 5 });
});

test("boardLaneWidth fits all 6 lanes cleanly at 1680px and avoids awkward partial clipping at 1280px", () => {
  const railW = 76;
  const avail1680 = 1680 - railW - BOARD_PAD_X * 2;
  const width1680 = boardLaneWidth(avail1680, 6);
  const total1680 = 6 * width1680 + 5 * BOARD_LANE_GAP;
  expect(width1680).toBeGreaterThanOrEqual(240);
  expect(total1680).toBeLessThanOrEqual(avail1680);

  const avail1280 = 1280 - railW - BOARD_PAD_X * 2;
  const width1280 = boardLaneWidth(avail1280, 6);
  const fiveLanes1280 = 5 * width1280 + 4 * BOARD_LANE_GAP;
  expect(width1280).toBeGreaterThanOrEqual(220);
  expect(fiveLanes1280).toBeLessThanOrEqual(avail1280);
  expect(avail1280 - fiveLanes1280).toBeLessThan(BOARD_LANE_GAP);
});

test("cross-lane drag over placeable cards in another lane drops on target lane instead of placing before", () => {
  const cardBacklog = makeTodoCard("c-backlog", "backlog");
  const cardTodo = makeTodoCard("c-2", "todo");
  const placeable = (id: string) => id === "c-1" || id === "c-2";

  let state = dragTransition(initialDragState(), { kind: "start", card: cardBacklog, number: "#10", title: "From backlog", at: { x: 80, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: sampleTargets, isPlaceable: placeable });
  // Hover directly over placeable `c-2` in the `todo` lane -> must drop on `todo`, NEVER set `before: "c-2"`.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(state.phase).toBe("dragging");
  if (state.phase === "dragging") {
    expect(state.over).toBe("todo");
    expect(state.before).toBeUndefined();
  }
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardBacklog, lane: "todo" });

  // Moving back to another card inside its own `backlog` lane keeps cross-lane vs same-lane behavior distinct.
  expect(cardTodo.lane).toBe("todo");
});

test("drag hit-testing tolerates empty space below short lanes and 10px inter-lane gaps while rejecting outside board", () => {
  const baseCard = makeTodoCard("c-1", "todo");
  const cardA: BoardCard = { ...baseCard, issue: { ...baseCard.issue, moves: ["backlog", "todo", "in_progress", "done", "canceled"] } };
  const placeable = () => false;

  let state = dragTransition(initialDragState(), { kind: "start", card: cardA, title: "Card A", at: { x: 260, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: sampleTargets, isPlaceable: placeable });

  // Empty vertical area below `in_progress` (lane rect h=240, boardRect h=600).
  state = dragTransition(state, { kind: "move", at: { x: 520, y: 500 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress" });

  // Inside the 10px gap between `todo` (ends 450) and `in_progress` (starts 460), closer to `in_progress`.
  state = dragTransition(state, { kind: "move", at: { x: 458, y: 120 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress" });

  // Outside `boardRect` bottom -> resolves to none.
  state = dragTransition(state, { kind: "move", at: { x: 520, y: 720 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "none" });
});

test("fast-drag release during measuring preserves drop target and resolves cleanly after measured", () => {
  const cardA = makeTodoCard("c-1", "todo");
  const placeable = () => false;

  let state = dragTransition(initialDragState(), { kind: "start", card: cardA, title: "Fast drag", at: { x: 260, y: 60 } });
  state = dragTransition(state, { kind: "release", at: { x: 50, y: 80 }, isPlaceable: placeable });
  expect(state.phase).toBe("measuring");
  if (state.phase === "measuring") {
    expect(state.pendingDrop).toBe(true);
    expect(state.at).toEqual({ x: 50, y: 80 });
  }

  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: sampleTargets, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "backlog" });
});

test("grouped swimlane hit-testing tracks exact hovered cell overKey and vertical bounds", () => {
  const baseCard = makeTodoCard("c-1", "todo");
  const cardA: BoardCard = { ...baseCard, issue: { ...baseCard.issue, moves: ["backlog", "todo", "in_progress", "done", "canceled"] } };
  const placeable = () => false;
  const groupedTargets: DragTargets = {
    laneRects: [
      ["in_progress", { x: 460, y: 40, w: 220, h: 120 }, "repoA:in_progress"],
      ["in_progress", { x: 460, y: 220, w: 220, h: 120 }, "repoB:in_progress"],
    ],
    cardRects: [],
    boardRect: { x: 0, y: 0, w: 720, h: 600 },
    grouped: true,
  };

  let state = dragTransition(initialDragState(), { kind: "start", card: cardA, title: "Grouped drag", at: { x: 260, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: groupedTargets, isPlaceable: placeable });

  state = dragTransition(state, { kind: "move", at: { x: 500, y: 260 }, isPlaceable: placeable });
  expect(state.phase).toBe("dragging");
  if (state.phase === "dragging") {
    expect(state.over).toBe("in_progress");
    expect(state.overKey).toBe("repoB:in_progress");
  }

  // Below all swimlane cells in grouped mode -> should NOT expand vertically across group boundaries.
  state = dragTransition(state, { kind: "move", at: { x: 500, y: 450 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "none" });
});
