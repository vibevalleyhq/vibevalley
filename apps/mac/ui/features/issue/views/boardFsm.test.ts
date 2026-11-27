import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { AppliedIssue, Issue, IssueId } from "@vibevalley/protocol";

import type { Intent } from "../../../infra/state/intent";
import type { BoardCard } from "../model/cards";
import { type IssueMove, movedCards, placedCards } from "../model/moves";
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
    expect(state.before).toBe("c-2");
  }

  // Move over top half of c-2 (y=130..210, mid=170) -> `before: "c-2"`; drop outcome is `place`.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "place", card: cardA, before: "c-2" });

  // Move past bottom half of c-2 (y=190 >= 170) -> `before: ""` (end of lane); drop outcome is `place` with `before: undefined`.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 190 }, isPlaceable: placeable });
  expect(state.phase).toBe("dragging");
  if (state.phase === "dragging") expect(state.before).toBe("");
  expect(dragDropOutcome(state, true)).toEqual({ kind: "place", card: cardA, before: undefined });

  // Move over empty backlog lane -> outcome is `drop` on backlog at end (`before: ""`).
  state = dragTransition(state, { kind: "move", at: { x: 50, y: 50 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "backlog", before: "" });
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

test("cross-lane drag computes exact midline insertion slot (first / middle / end) on manually ordered open lanes", () => {
  const cardBacklog = makeTodoCard("c-backlog", "backlog");
  const placeable = (id: string) => id === "c-1" || id === "c-2";

  let state = dragTransition(initialDragState(), { kind: "start", card: cardBacklog, number: "#10", title: "From backlog", at: { x: 80, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: sampleTargets, isPlaceable: placeable });

  // Above c-1 midline (y=40..120, mid=80) -> insert before c-1.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 60 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardBacklog, lane: "todo", before: "c-1" });

  // Between c-1 midline (80) and c-2 midline (170) -> insert before c-2.
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardBacklog, lane: "todo", before: "c-2" });

  // Below c-2 midline (170) -> insert at end of todo lane (`before: ""`).
  state = dragTransition(state, { kind: "move", at: { x: 280, y: 200 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardBacklog, lane: "todo", before: "" });
});

test("non-manual ordering, closed lanes, and started issues omit manual slot placement (`before: undefined`)", () => {
  const todoCard = makeTodoCard("c-backlog", "backlog");
  const placeable = (id: string) => id === "c-1" || id === "c-2";
  const targetsWithDone: DragTargets = {
    ...sampleTargets,
    laneRects: [...sampleTargets.laneRects, ["done", { x: 690, y: 0, w: 220, h: 400 }]],
  };

  // Non-manual ordering (priority) on open lane: cross-lane drop has no fake mid-column slot, same-lane rejected.
  let prioState = dragTransition(initialDragState(), { kind: "start", card: todoCard, title: "Priority sort", at: { x: 80, y: 60 } });
  prioState = dragTransition(prioState, {
    kind: "measured",
    epoch: prioState.epoch,
    ghost: sampleGhost,
    targets: { ...targetsWithDone, ordering: "priority" },
    isPlaceable: placeable,
  });
  prioState = dragTransition(prioState, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(dragDropOutcome(prioState, true)).toEqual({ kind: "drop", card: todoCard, lane: "todo" });
  prioState = dragTransition(prioState, { kind: "move", at: { x: 80, y: 60 }, isPlaceable: placeable });
  expect(dragDropOutcome(prioState, true)).toEqual({ kind: "none" });

  // Closed target lane (`done`): never sets `before`.
  let closedState = dragTransition(initialDragState(), { kind: "start", card: todoCard, title: "Close drop", at: { x: 80, y: 60 } });
  closedState = dragTransition(closedState, {
    kind: "measured",
    epoch: closedState.epoch,
    ghost: sampleGhost,
    targets: targetsWithDone,
    isPlaceable: placeable,
  });
  closedState = dragTransition(closedState, { kind: "move", at: { x: 750, y: 100 }, isPlaceable: placeable });
  expect(dragDropOutcome(closedState, true)).toEqual({ kind: "drop", card: todoCard, lane: "done" });

  // Started issue (`kind: "issue"`): cannot set `before` even on open manually-ordered lanes.
  const startedCard: BoardCard = {
    id: "c-started",
    kind: "issue",
    lane: "in_progress",
    issue: { ...makeIssue("c-started", "in_progress"), moves: ["todo", "in_progress", "done"] },
    sessions: [],
    tag: "working",
  };
  let startedState = dragTransition(initialDragState(), { kind: "start", card: startedCard, title: "Started", at: { x: 500, y: 60 } });
  startedState = dragTransition(startedState, {
    kind: "measured",
    epoch: startedState.epoch,
    ghost: sampleGhost,
    targets: targetsWithDone,
    isPlaceable: placeable,
  });
  startedState = dragTransition(startedState, { kind: "move", at: { x: 280, y: 150 }, isPlaceable: placeable });
  expect(dragDropOutcome(startedState, true)).toEqual({ kind: "drop", card: startedCard, lane: "todo" });
});

test("drag hit-testing tolerates empty space below short lanes and 10px inter-lane gaps while rejecting outside board", () => {
  const baseCard = makeTodoCard("c-1", "todo");
  const cardA: BoardCard = { ...baseCard, issue: { ...baseCard.issue, moves: ["backlog", "todo", "in_progress", "done", "canceled"] } };
  const placeable = () => false;

  let state = dragTransition(initialDragState(), { kind: "start", card: cardA, title: "Card A", at: { x: 260, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: sampleTargets, isPlaceable: placeable });

  // Empty vertical area below `in_progress` (lane rect h=240, boardRect h=600).
  state = dragTransition(state, { kind: "move", at: { x: 520, y: 500 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress", before: "" });

  // Inside the 10px gap between `todo` (ends 450) and `in_progress` (starts 460), closer to `in_progress`.
  state = dragTransition(state, { kind: "move", at: { x: 458, y: 120 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress", before: "" });

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
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "backlog", before: "" });
});

test("grouped swimlane hit-testing tracks exact hovered cell overKey, vertical bounds, and per-cell card slots", () => {
  const baseCard = makeTodoCard("c-1", "todo");
  const cardA: BoardCard = { ...baseCard, issue: { ...baseCard.issue, moves: ["backlog", "todo", "in_progress", "done", "canceled"] } };
  const placeable = (id: string) => id === "ra-1" || id === "rb-1";
  const groupedTargets: DragTargets = {
    laneRects: [
      ["in_progress", { x: 460, y: 40, w: 220, h: 140 }, "repoA:in_progress"],
      ["in_progress", { x: 460, y: 220, w: 220, h: 140 }, "repoB:in_progress"],
    ],
    cardRects: [
      ["ra-1", { x: 470, y: 50, w: 200, h: 80 }, "in_progress", "repoA:in_progress"],
      ["rb-1", { x: 470, y: 230, w: 200, h: 80 }, "in_progress", "repoB:in_progress"],
    ],
    boardRect: { x: 0, y: 0, w: 720, h: 600 },
    grouped: true,
  };

  let state = dragTransition(initialDragState(), { kind: "start", card: cardA, title: "Grouped drag", at: { x: 260, y: 60 } });
  state = dragTransition(state, { kind: "measured", epoch: state.epoch, ghost: sampleGhost, targets: groupedTargets, isPlaceable: placeable });

  // Top half of rb-1 (y=230..310, mid=270) inside repoB cell -> picks rb-1, ignores ra-1.
  state = dragTransition(state, { kind: "move", at: { x: 500, y: 250 }, isPlaceable: placeable });
  expect(state.phase).toBe("dragging");
  if (state.phase === "dragging") {
    expect(state.over).toBe("in_progress");
    expect(state.overKey).toBe("repoB:in_progress");
    expect(state.before).toBe("rb-1");
  }
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress", before: "rb-1" });

  // Bottom half of rb-1 -> appends to end of repoB cell (`before: ""`).
  state = dragTransition(state, { kind: "move", at: { x: 500, y: 295 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "drop", card: cardA, lane: "in_progress", before: "" });

  // Below all swimlane cells in grouped mode -> should NOT expand vertically across group boundaries.
  state = dragTransition(state, { kind: "move", at: { x: 500, y: 450 }, isPlaceable: placeable });
  expect(dragDropOutcome(state, true)).toEqual({ kind: "none" });
});

test("movedCards and placedCards optimistically place dragged cards at the exact target slot", () => {
  const c1 = makeTodoCard("c-1", "todo");
  const c2 = makeTodoCard("c-2", "todo");
  const c3 = makeTodoCard("c-3", "backlog");

  const crossMove: Intent<IssueMove, AppliedIssue> = {
    key: "k-1",
    phase: "sending",
    input: { id: "c-3", status: "todo", lane: "todo", before: "c-2", edit: { before: "c-2" } },
  };
  const afterCross = movedCards([c1, c2, c3], [crossMove]);
  expect(afterCross.map((c) => `${c.id}:${c.lane}`)).toEqual(["c-1:todo", "c-3:todo", "c-2:todo"]);

  // Append to end via empty string `before: ""`.
  const afterSame = placedCards([c1, c2, c3], [{ id: "c-1", before: "" }]);
  expect(afterSame.map((c) => c.id)).toEqual(["c-2", "c-3", "c-1"]);
});
