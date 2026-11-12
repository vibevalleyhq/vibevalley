import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";

import { holdReasonOf } from "./routing.ts";

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
