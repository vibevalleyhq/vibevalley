import { expect, test } from "vite-plus/test";

import type { ChannelAudience } from "@/channel/contracts.ts";
import { brakes, type BrakeInput } from "@/mailbox/brakes.ts";
import type { InboxMessage, UnreadRow } from "@/mailbox/chat.ts";
import { wakeInput } from "@/mailbox/prompts.ts";
import { whoHears } from "@/mailbox/routing.ts";
import { checkCases, goldenCases } from "@/testing/golden.ts";

import { channelNameProblem, mentionsIn, parseChatTarget } from "./mentions.ts";
const chatAudience = (input: ChannelAudience & BrakeInput) => brakes(whoHears(input), input);

test("regression: a delivery batch includes every acknowledged card", () => {
  const messages: InboxMessage[] = Array.from({ length: 5 }, (_, i) => ({
    id: `delivery-${i}`,
    number: i + 1,
    target: "#room",
    from: "owner",
    fromKind: "owner",
    name: "owner",
    text: `body-text-${i}`,
  }));
  const input = wakeInput(messages, []);
  for (const message of messages) expect(input).toContain(message.text);
});

test("the recorded cases", () => {
  const cases = goldenCases("channel");
  expect(new Set(cases.map((c) => c.fn)).size).toBe(5);
  const failed = checkCases(cases, (c) => {
    switch (c.fn) {
      case "mentionsIn":
        return mentionsIn(c.in as string);
      case "parseTarget": {
        // As Go writes it: a zero parent is left out.
        const t = parseChatTarget(c.in as string);
        return t?.kind === "thread" && t.root === 0 ? { kind: "thread" } : (t ?? null);
      }
      case "channelNameProblem": {
        const i = c.in as { name: string; taken: string[] | null };
        return channelNameProblem(i.name, i.taken ?? []) || null;
      }
      case "audienceOf":
        return brakes(whoHears(c.in as ChannelAudience), c.in as BrakeInput);
      case "wakeInput": {
        const i = c.in as { messages: InboxMessage[] | null; others: UnreadRow[] | null };
        return wakeInput(i.messages ?? [], i.others ?? []);
      }
      default:
        throw new Error(`line ${c.line}: no rule ${c.fn}`);
    }
  });
  expect(failed).toEqual([]);
});

test("with several orchestrators: the place's hears the owner, 管家 is the place's, and each is named by its id", () => {
  const names = { here: "lead", orchestrators: ["orchestrator", "lead", "agent-1", "agent-12"] };
  expect(mentionsIn("@管家 看看，@agent-12 也看看，@agent-1", names)).toEqual(["lead", "agent-12", "agent-1"]);
  expect(mentionsIn("@orchestrator 你呢 `@lead`", names)).toEqual(["orchestrator"]);
  expect(mentionsIn("@lead 在吗")).toEqual([]);
  const base: ChannelAudience & BrakeInput = {
    from: "owner",
    fromKind: "owner",
    kind: "chat",
    mentions: [],
    channel: { type: "channel" },
    orchestrator: "lead",
    orchestrators: ["orchestrator", "lead"],
    sessions: ["w1"],
    followers: [],
    hops: 0,
    cooling: [],
    broken: [],
  };
  expect(chatAudience(base).map((d) => [d.recipient, d.reason, d.wakes])).toEqual([
    ["lead", "addressed", true],
    ["w1", "channel", false],
  ]);
  expect(chatAudience({ ...base, mentions: ["orchestrator"] }).map((d) => [d.recipient, d.reason])).toEqual([
    ["orchestrator", "mention"],
    ["w1", "channel"],
  ]);
  expect(chatAudience({ ...base, channel: { type: "direct", peer: "lead" }, orchestrator: "lead" }).map((d) => d.recipient)).toEqual(["lead"]);
  // An orchestrator answering another is never cooled down, as a session would be.
  expect(chatAudience({ ...base, from: "orchestrator", fromKind: "orchestrator", mentions: ["lead"], cooling: ["lead"] })).toEqual([
    { recipient: "lead", reason: "mention", wakes: true },
  ]);
});
