import { describe, expect, it } from "vite-plus/test";

import { compactCard } from "./card.ts";

describe("a compact ingress card", () => {
  it("keeps the resource pointer and measures UTF-16 offsets used by resource_read", () => {
    const text = "甲😀乙";
    expect(compactCard(text, "vv://envelope/e1", 3)).toEqual({
      summary: "甲😀",
      totalChars: 4,
      truncated: true,
      readUri: "vv://envelope/e1",
    });
  });

  it("bounds the requested size without truncating content that fits", () => {
    expect(compactCard("abc", "vv://envelope/e2", 3).truncated).toBe(false);
    expect(compactCard("abc", "vv://envelope/e2", -1).summary).toBe("");
  });
});
