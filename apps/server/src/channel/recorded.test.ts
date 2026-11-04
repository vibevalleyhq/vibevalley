import { describe, expect, it, test } from "vite-plus/test";

import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { artifactId, blockId } from "@vibevalley/protocol/schema";

import type { ChannelAudience } from "#/channel/contracts.ts";
import { brakes, type BrakeInput } from "#/mailbox/brakes.ts";
import type { InboxMessage, UnreadRow } from "#/mailbox/envelope.ts";
import { messageLine, wakeInput } from "#/mailbox/prompts.ts";
import { whoHears } from "#/mailbox/routing.ts";
import { checkCases, goldenCases } from "#/testing/golden.ts";

import { channelNameProblem, mentionsIn, parseChatTarget } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { Follows } from "./rooms.ts";

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

test("an @ right after Chinese names someone, and one inside a Latin word or an address does not", () => {
  expect(mentionsIn("问@w3 看看")).toEqual(["w3"]);
  expect(mentionsIn("「@w3」你呢")).toEqual(["w3"]);
  expect(mentionsIn("mail a@w3.dev, x@@w3")).toEqual([]);
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

describe("channel follows", () => {
  it("loads and updates who follows each thread", () => {
    const follows = new Follows();
    follows.load([{ channel_id: "t", participant_id: "w3" }]);
    follows.followed("t", "w1");
    follows.followed("t", "w3");
    expect(follows.followers("t")).toEqual(["w1", "w3"]);
    expect(follows.followers("other")).toEqual([]);
  });

  it("forgets a session that left", () => {
    const follows = new Follows();
    follows.load([
      { channel_id: "t", participant_id: "w3" },
      { channel_id: "u", participant_id: "w3" },
      { channel_id: "u", participant_id: "w1" },
    ]);
    follows.left("w3");
    expect([follows.followers("t"), follows.followers("u")]).toEqual([[], ["w1"]]);
  });
});

describe("a search", () => {
  it("reads its filters out of its words, and leaves one it cannot read among them", () => {
    expect(parseSearch("苹果 from:管家 in:#clock-in has:image has:link")).toEqual({
      words: "苹果",
      from: defaultOrchestrator,
      in: "clock-in",
      has: ["image", "link"],
    });
    expect(parseSearch("from:@主人 来了").from).toBe(ownerId);
    expect(parseSearch("from:w3").from).toBe("w3");
    const day = parseSearch("before:2026-10-28 after:2026-10-01 has:pdf");
    expect([day.before, day.after, day.words]).toEqual([new Date(2026, 9, 28).getTime(), new Date(2026, 9, 1).getTime(), "has:pdf"]);
    expect(parseSearch("before:明天").words).toBe("before:明天");
  });
});

const said = {
  id: "m",
  number: 1,
  target: "#general",
  from: "owner",
  fromKind: "owner" as const,
  name: "主人",
  text: "看这块",
};

it("tells a helper which block a message points at, the version quoted and how it reads now", () => {
  const line = messageLine({
    ...said,
    blocks: [{ artifactId: artifactId("a"), blockId: blockId("b"), rev: 1, title: "周报", type: "paragraph", text: "原来", nowRev: 2 }],
  });
  expect(line).toContain("artifact=a block=b");
  expect(line).toContain("引用时第 1 版");
  expect(line).toContain("现在第 2 版");
  expect(line).toContain("原来");
});

it("says a quoted block is gone rather than showing words that no longer count", () => {
  const line = messageLine({
    ...said,
    blocks: [{ artifactId: artifactId("a"), blockId: blockId("b"), rev: 1, title: "周报", deleted: true }],
  });
  expect(line).toContain("已删除");
  expect(line).not.toContain("原来");
});
