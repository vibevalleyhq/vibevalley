import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";

import { brakes, type BrakeInput } from "./brakes.ts";
import type { ChannelAudience } from "./envelope.ts";
import { holdReasonOf, whoHears } from "./routing.ts";

const chatAudience = (input: ChannelAudience & BrakeInput) => brakes(whoHears(input), input);

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

test("with several orchestrators: the place's hears the user, and an orchestrator answering another is not cooled down", () => {
  const base: ChannelAudience & BrakeInput = {
    from: "user",
    actor: { kind: "user", id: "user" },
    kind: "chat",
    mentions: [],
    channel: { type: "channel" },
    orchestrator: "lead",
    channelMembers: ["lead"],
    orchestrators: ["orchestrator", "lead"],
    sessions: ["w1"],
    members: [],
    hops: 0,
    cooling: [],
    broken: [],
  };
  expect(chatAudience(base).map((d) => [d.recipient, d.reason, d.wakes])).toEqual([
    ["lead", "addressed", true],
    ["w1", "channel", false],
  ]);
  // No one in the channel: what the user says there to no one in particular wakes no one.
  expect(chatAudience({ ...base, channelMembers: [] })).toEqual([{ recipient: "w1", reason: "channel", wakes: false }]);
  expect(chatAudience({ ...base, mentions: ["orchestrator"] }).map((d) => [d.recipient, d.reason])).toEqual([
    ["orchestrator", "mention"],
    ["w1", "channel"],
  ]);
  expect(chatAudience({ ...base, channel: { type: "direct", peer: "lead" }, orchestrator: "lead" }).map((d) => d.recipient)).toEqual(["lead"]);
  // An orchestrator answering another is never cooled down, as a session would be.
  expect(
    chatAudience({ ...base, from: "orchestrator", actor: { kind: "agent", id: "orchestrator", role: "orchestrator" }, mentions: ["lead"], cooling: ["lead"] }),
  ).toEqual([{ recipient: "lead", reason: "mention", wakes: true }]);
});
