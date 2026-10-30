import { expect, test } from "vite-plus/test";

import { checkCases, goldenCases } from "@/testing/golden.ts";

import { type AudienceInput, chatAudience } from "./audience.ts";
import { mentionsIn } from "./mentions.ts";
import { busyNotice, wakeInput } from "./prompts.ts";
import { channelNameProblem, parseChatTarget } from "./targets.ts";
import type { InboxMessage, UnreadRow } from "./wake.ts";
test("the recorded cases", () => {
  const cases = goldenCases("channel");
  expect(new Set(cases.map((c) => c.fn)).size).toBe(6);
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
        return chatAudience(c.in as AudienceInput);
      case "wakeInput": {
        const i = c.in as { messages: InboxMessage[] | null; others: UnreadRow[] | null };
        return wakeInput(i.messages ?? [], i.others ?? []);
      }
      case "busyNotice":
        return busyNotice((c.in as UnreadRow[] | null) ?? []);
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
  const base: AudienceInput = {
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
