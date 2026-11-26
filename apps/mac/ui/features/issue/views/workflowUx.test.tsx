import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { type BoardCard, cardLook, cardMove, cardUrgencyTone } from "../model/cards";

function makeUnsentIssue(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number; title: string }): Issue {
  return {
    description: "Verify unsent external-MCP workflow transitions and interactive criteria checklist.",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "backlog",
    moves: ["todo", "in_progress", "in_review", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: ["Check status transition", "[x] Existing checked item"],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 60_000,
    stage: { state: "draft", acts: [] },
    ...overrides,
    id: overrides.id as IssueId,
  };
}

test("cardMove unlocks 6-lane tracking for unsent todo cards while keeping backlog->todo dispatch as start", () => {
  setLocale("zh");
  const manualTodo: BoardCard = {
    kind: "todo",
    id: "i-manual",
    lane: "backlog",
    issue: makeUnsentIssue({ id: "i-manual", number: 51, title: "Manual task" }),
  };
  expect(cardMove(manualTodo, "in_progress")).toBe("track");
  expect(cardMove(manualTodo, "in_review")).toBe("track");
  expect(cardMove(manualTodo, "done")).toBe("close");
  expect(cardMove(manualTodo, "canceled")).toBe("close");
  expect(cardMove(manualTodo, "todo")).toBe("start");

  const assignedTodo: BoardCard = {
    kind: "todo",
    id: "i-assigned",
    lane: "backlog",
    issue: makeUnsentIssue({
      id: "i-assigned",
      number: 52,
      title: "Assigned task",
      repo: "vibevalley",
      assignments: [
        {
          id: "a1",
          issue: "i-assigned" as IssueId,
          agent: "laozhou",
          assignedAt: SCENARIO_NOW,
          executions: [],
        },
      ],
    }),
  };
  expect(cardMove(assignedTodo, "todo")).toBe("start");
  expect(cardMove(assignedTodo, "in_progress")).toBe("track");
  expect(cardMove(assignedTodo, "in_review")).toBe("track");

  const waitingTodo: BoardCard = {
    kind: "todo",
    id: "i-waiting",
    lane: "in_review",
    issue: makeUnsentIssue({
      id: "i-waiting",
      number: 53,
      title: "Waiting review",
      status: "in_review",
      moves: ["backlog", "todo", "in_progress", "done", "canceled"],
      stage: { state: "reviewing", acts: [] },
    }),
  };
  expect(cardMove(waitingTodo, "backlog")).toBe("track");
  expect(cardMove(waitingTodo, "todo")).toBe("track");
  expect(cardMove(waitingTodo, "in_progress")).toBe("track");
  expect(cardMove(waitingTodo, "done")).toBe("close");
  expect(cardMove(waitingTodo, "canceled")).toBe("close");
  expect(cardUrgencyTone(waitingTodo)).toBe("wheat");
  expect(cardLook(waitingTodo, (id) => id, [waitingTodo.issue], SCENARIO_NOW).flags).not.toContainEqual({
    text: t("shared.stage.reviewing"),
    tone: "wheat",
  });

  const closedTodo: BoardCard = {
    kind: "todo",
    id: "i-done",
    lane: "done",
    issue: makeUnsentIssue({
      id: "i-done",
      number: 54,
      title: "Closed manual",
      status: "done",
      moves: ["backlog", "todo", "in_progress", "in_review", "canceled"],
      stage: { state: "done", acts: [] },
    }),
  };
  expect(cardMove(closedTodo, "backlog")).toBe("revive");
  expect(cardMove(closedTodo, "todo")).toBe("track");
  expect(cardMove(closedTodo, "in_progress")).toBe("track");
  expect(cardMove(closedTodo, "in_review")).toBe("track");
});

test("TodoDetail toggles criteria [x] persistence, exposes all 6 statuses in Pick, and avoids redundant in_review banners/buttons", async () => {
  setLocale("zh");
  let current = makeUnsentIssue({
    id: "i-wf-1",
    number: 34,
    title: "Track external MCP issue workflow",
    status: "in_progress",
    moves: ["backlog", "todo", "in_review", "done", "canceled"],
    stage: { state: "working", acts: [] },
  });

  let boardSeq = 30;
  let boundApp: Awaited<ReturnType<typeof open>> | undefined;
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: boardSeq, issues: [current] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${current.id}`, locale: "zh" });
  fake.respond("issue.history.list", () => [{ issue: current, sessions: [], missingSessions: [] }]);
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { criteria?: string[] };
    if (p.criteria) current = { ...current, criteria: p.criteria };
    return { ...current, seq: ++boardSeq };
  });
  fake.respond("issue.status.update", (payload: unknown) => {
    const p = payload as { status: Issue["status"] };
    current = {
      ...current,
      status: p.status,
      stage: { state: p.status === "in_review" ? "reviewing" : p.status === "done" ? "done" : "working", acts: [] },
    };
    const nextSeq = ++boardSeq;
    if (boundApp) {
      queueMicrotask(() => {
        void fake.setSlice(boundApp!, "board", { seq: nextSeq, issues: [current] });
      });
    }
    return { ...current, seq: nextSeq };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  boundApp = app;
  await fake.pumpUntil(app, () => app.count("id:todo-criterion") === 2);

  // Initial criteria state: 1 unchecked, 1 checked ([x] stripped visually).
  expect(app.count("id:todo-criterion-unchecked")).toBe(1);
  expect(app.count("id:todo-criterion-checked")).toBe(1);
  expect(app.texts()).toContain("Existing checked item");
  expect(app.texts().join("\n")).not.toContain("[x] Existing checked item");

  // Click first criterion: toggles to [x] and persists via api.issue.update.
  await app.press("id:todo-criterion >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:todo-criterion-checked") === 2);
  const firstUpdate = fake.calls.findLast((c) => c.op === "issue.update");
  expect((firstUpdate?.payload as { criteria?: string[] } | undefined)?.criteria).toEqual(["[x] Check status transition", "[x] Existing checked item"]);

  // Click second criterion: unchecks [x] and persists.
  await app.press("id:todo-criterion >> nth=1");
  await fake.pumpUntil(app, () => app.count("id:todo-criterion-unchecked") === 1 && app.count("id:todo-criterion-checked") === 1);
  const secondUpdate = fake.calls.findLast((c) => c.op === "issue.update");
  expect((secondUpdate?.payload as { criteria?: string[] } | undefined)?.criteria).toEqual(["[x] Check status transition", "Existing checked item"]);

  // Status picker includes in_review ("待验收") and switches status cleanly.
  await app.press("id:todo-status");
  await fake.pumpUntil(app, () => app.count(`text:${t("shared.status.in_review")}`) >= 1);
  await app.press(`text:${t("shared.status.in_review")}`);
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));
  const toReview = fake.calls.findLast((c) => c.op === "issue.status.update");
  expect((toReview?.payload as { status?: string } | undefined)?.status).toBe("in_review");

  // When liveStatus is in_review, no redundant yellow banner, duplicate stage pill, or duplicate status buttons appear; completing via status Pick works cleanly.
  await fake.pumpUntil(app, () => !app.texts().includes(t("web.issue.acts.moving")));
  expect(app.count("id:todo-review-banner")).toBe(0);
  expect(app.count("id:todo-accept")).toBe(0);
  expect(app.count("id:todo-accept-side")).toBe(0);
  expect(app.count("id:todo-stage-pill")).toBe(0);
  expect(app.count("id:todo-mark-done")).toBe(0);
  expect(app.count("id:todo-mark-canceled")).toBe(0);

  await app.press("id:todo-status");
  await fake.pumpUntil(app, () => app.count(`text:${t("shared.status.done")}`) >= 1);
  await app.press(`text:${t("shared.status.done")}`);
  await fake.pumpUntil(app, () => app.count("id:todo-revive") === 1);
  const toDone = fake.calls.findLast((c) => c.op === "issue.status.update");
  expect((toDone?.payload as { status?: string } | undefined)?.status).toBe("done");
});
