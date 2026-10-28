import { describe, expect, it } from "vite-plus/test";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { parseSearch } from "./rules.ts";

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
