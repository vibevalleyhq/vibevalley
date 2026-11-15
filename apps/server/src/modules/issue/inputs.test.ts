import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { IssueStatusValues } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { goesOnFrom, holdReasonOf, readyInputs } from "./inputs.ts";
import type { IssueMandate } from "./status.ts";

const defaultMandate: IssueMandate = { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false };
const issue = (state: T.IssueStage["state"], status: T.IssueStatus = "in_progress") => ({
  status,
  stage: { state, acts: [] },
  mandate: defaultMandate,
});
const bot = (botRound?: number) => ({ meta: botRound === undefined ? {} : { botRound }, actor: { kind: "system" as const, id: "ci" } });
const user = { meta: {}, actor: { kind: "user" as const, id: "user" } };

test("an issue's input stays held when closed, past its bot rounds, with no one to take it, or while the issue waits on the user", () => {
  expect(holdReasonOf(user, issue("done", "done"), "w1", true)).toBe("closed");
  expect(holdReasonOf(bot(), issue("canceled", "canceled"), "w1", false)).toBe("closed");
  expect(holdReasonOf(bot(3), issue("working"), "w1", false)).toBe("budget");
  expect(holdReasonOf(bot(3), issue("working"), "w1", true)).toBeUndefined();
  expect(holdReasonOf(bot(2), issue("working"), "w1", false)).toBeUndefined();
  expect(holdReasonOf(bot(), issue("working"), undefined, false)).toBe("session");
  expect(holdReasonOf(user, issue("working"), undefined, true)).toBe("session");
  expect(holdReasonOf(bot(), issue("asking"), "w1", false)).toBe("human");
  expect(holdReasonOf(bot(), issue("reviewing"), "w1", true)).toBeUndefined();
  expect(holdReasonOf(user, issue("stuck"), "w1", false)).toBeUndefined();
});

test("a session is handed none of a closed issue's inputs, and while its issue waits on the user only the user's words or what waits with them", () => {
  const board: Record<string, Pick<T.Issue, "id" | "status" | "stage">> = {
    open: { id: issueId("open"), status: "in_progress", stage: { state: "working", acts: [] } },
    asking: { id: issueId("asking"), status: "in_progress", stage: { state: "asking", acts: [] } },
    done: { id: issueId("done"), status: "done", stage: { state: "working", acts: [] } },
  };
  const of = (id: string) => board[id];
  const bots = { fromUser: false, pending: true };
  expect(readyInputs([{ ...bots }, { issue: "gone", ...bots }, { issue: "open", ...bots }], of)).toEqual([true, true, true]);
  expect(
    readyInputs(
      [
        { issue: "done", ...bots },
        { issue: "done", fromUser: true, pending: true },
      ],
      of,
    ),
  ).toEqual([false, false]);
  expect(readyInputs([{ issue: "asking", ...bots }], of)).toEqual([false]);
  expect(
    readyInputs(
      [
        { issue: "asking", ...bots },
        { issue: "asking", fromUser: true, pending: false },
      ],
      of,
    ),
  ).toEqual([false, true]);
  expect(
    readyInputs(
      [
        { issue: "asking", ...bots },
        { issue: "asking", fromUser: true, pending: true },
      ],
      of,
    ),
  ).toEqual([true, true]);
});

test("holdReasonOf and readyInputs stay aligned across actor.kind x stage.state x open/closed", () => {
  const actorsByKind: Record<T.Actor["kind"], T.Actor> = {
    user: { kind: "user", id: "user" },
    agent: { kind: "agent", id: "w2", role: "worker" },
    system: { kind: "system", id: "ci" },
  };
  const stageWaitsForHuman: Record<T.IssueStageKind, boolean> = {
    draft: false,
    queued: false,
    working: false,
    asking: true,
    reviewing: true,
    stuck: true,
    done: false,
    canceled: false,
  };
  const openByStatus: Record<T.IssueStatus, boolean> = {
    backlog: true,
    todo: true,
    in_progress: true,
    in_review: true,
    done: false,
    canceled: false,
  };
  const actorKinds: readonly T.Actor["kind"][] = ["user", "agent", "system"];
  const stageStates: readonly T.IssueStageKind[] = ["draft", "queued", "working", "asking", "reviewing", "stuck", "done", "canceled"];
  const id = issueId("matrix");

  for (const actorKind of actorKinds) {
    const actor = actorsByKind[actorKind];
    const fromUser = actor.kind === "user";
    for (const stageState of stageStates) {
      for (const status of IssueStatusValues) {
        const item = { id, status, stage: { state: stageState, acts: [] }, mandate: defaultMandate };
        const lookup = (target: string) => (target === id ? item : undefined);

        const soloExpected = openByStatus[status] && (!stageWaitsForHuman[stageState] || fromUser);
        const soloPoolPasses = holdReasonOf({ meta: {}, actor }, item, "w1", false) === undefined;
        const [soloMailboxPasses] = readyInputs([{ issue: id, fromUser, pending: true }], lookup);
        expect({ actorKind, stageState, status, soloPoolPasses, soloMailboxPasses }).toEqual({
          actorKind,
          stageState,
          status,
          soloPoolPasses: soloExpected,
          soloMailboxPasses: soloExpected,
        });

        const withHumanExpected = openByStatus[status];
        const withHumanPoolPasses = holdReasonOf({ meta: {}, actor }, item, "w1", true) === undefined;
        const [withHumanMailboxPasses] = readyInputs(
          [
            { issue: id, fromUser, pending: true },
            { issue: id, fromUser: true, pending: true },
          ],
          lookup,
        );
        expect({ actorKind, stageState, status, withHumanPoolPasses, withHumanMailboxPasses }).toEqual({
          actorKind,
          stageState,
          status,
          withHumanPoolPasses: withHumanExpected,
          withHumanMailboxPasses: withHumanExpected,
        });
      }
    }
  }
});

test("an input goes on from its last session unless that session took it in or it was deleted", () => {
  expect(goesOnFrom(undefined)).toBe(true);
  expect(goesOnFrom({ state: "pending", dropped_why: null })).toBe(true);
  expect(goesOnFrom({ state: "handed", dropped_why: null })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "left" })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "reassigned" })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "deleted" })).toBe(false);
  expect(goesOnFrom({ state: "consumed", dropped_why: null })).toBe(false);
});
