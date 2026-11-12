import { describe, expect, it, test } from "vite-plus/test";

import { defaultOrchestrator, userId } from "@vibevalley/protocol";

import { mentionsIn } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { Members } from "./rooms.ts";

test("an @ right after Chinese names someone, and one inside a Latin word or an address does not", () => {
  expect(mentionsIn("问@w3 看看")).toEqual(["w3"]);
  expect(mentionsIn("「@w3」你呢")).toEqual(["w3"]);
  expect(mentionsIn("mail a@w3.dev, x@@w3")).toEqual([]);
});

test("with several orchestrators: 助手 is the place's, and each is named by its id", () => {
  const names = { here: "lead", orchestrators: ["orchestrator", "lead", "agent-1", "agent-12"] };
  expect(mentionsIn("@助手 看看，@agent-12 也看看，@agent-1", names)).toEqual(["lead", "agent-12", "agent-1"]);
  expect(mentionsIn("@orchestrator 你呢 `@lead`", names)).toEqual(["orchestrator"]);
  expect(mentionsIn("@lead 在吗")).toEqual([]);
});

describe("channel follows", () => {
  it("loads and updates who follows each thread", () => {
    const follows = new Members();
    follows.load([{ channel_id: "t", participant_id: "w3" }]);
    follows.memberAdded("t", "w1");
    follows.memberAdded("t", "w3");
    expect(follows.membersOf("t")).toEqual(["w1", "w3"]);
    expect(follows.membersOf("other")).toEqual([]);
  });

  it("forgets a session that left", () => {
    const follows = new Members();
    follows.load([
      { channel_id: "t", participant_id: "w3" },
      { channel_id: "u", participant_id: "w3" },
      { channel_id: "u", participant_id: "w1" },
    ]);
    follows.left("w3");
    expect([follows.membersOf("t"), follows.membersOf("u")]).toEqual([[], ["w1"]]);
  });
});

describe("a search", () => {
  it("reads its filters out of its words, and leaves one it cannot read among them", () => {
    expect(parseSearch("苹果 from:助手 in:#clock-in has:image has:link")).toEqual({
      words: "苹果",
      from: defaultOrchestrator,
      in: "clock-in",
      has: ["image", "link"],
    });
    expect(parseSearch("from:@用户 来了").from).toBe(userId);
    expect(parseSearch("from:w3").from).toBe("w3");
    const day = parseSearch("before:2026-10-28 after:2026-10-01 has:pdf");
    expect([day.before, day.after, day.words]).toEqual([new Date(2026, 9, 28).getTime(), new Date(2026, 9, 1).getTime(), "has:pdf"]);
    expect(parseSearch("before:明天").words).toBe("before:明天");
  });
});
