import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";

import { goesOnFrom, holdReasonOf, readyInputs } from "./inputs.ts";

const issue = (state: T.IssueStage["state"]) => ({ stage: { state } as T.IssueStage, mandate: { maxBotReviewRounds: 2 } as T.IssueMandate });
const bot = (botRound?: number) => ({ meta: botRound === undefined ? {} : { botRound }, actor: { kind: "system" as const, id: "ci" } });
const user = { meta: {}, actor: { kind: "user" as const, id: "user" } };

test("an issue's input stays held past its bot rounds, with no one to take it, or while the issue waits on the user", () => {
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
    open: { id: "open" as T.IssueId, status: "in_progress", stage: { state: "working" } as T.IssueStage },
    asking: { id: "asking" as T.IssueId, status: "in_progress", stage: { state: "asking" } as T.IssueStage },
    done: { id: "done" as T.IssueId, status: "done", stage: { state: "working" } as T.IssueStage },
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

test("an input goes on from its last session unless that session took it in or it was deleted", () => {
  expect(goesOnFrom(undefined)).toBe(true);
  expect(goesOnFrom({ state: "pending", dropped_why: null })).toBe(true);
  expect(goesOnFrom({ state: "handed", dropped_why: null })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "left" })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "reassigned" })).toBe(true);
  expect(goesOnFrom({ state: "dropped", dropped_why: "deleted" })).toBe(false);
  expect(goesOnFrom({ state: "consumed", dropped_why: null })).toBe(false);
});
