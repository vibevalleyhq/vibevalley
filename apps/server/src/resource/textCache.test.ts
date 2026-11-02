import { describe, expect, it } from "vite-plus/test";

import { TextCache } from "./textCache.ts";

describe("resource text snapshots", () => {
  it("evicts the least recently read snapshot by UTF-8 bytes", () => {
    const cache = new TextCache(6);
    expect(cache.put("a", "甲")).toBe(true);
    expect(cache.put("b", "乙")).toBe(true);
    expect(cache.get("a")).toBe("甲");
    expect(cache.put("c", "丙")).toBe(true);
    expect(cache.get("a")).toBe("甲");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("丙");
  });

  it("does not retain a snapshot larger than the whole cache", () => {
    const cache = new TextCache(3);
    expect(cache.put("large", "甲乙")).toBe(false);
    expect(cache.get("large")).toBeUndefined();
  });
});
