import { describe, expect, it } from "vite-plus/test";

import { harvestCoins } from "./progress.ts";

describe("the ledger's fold", () => {
  it("pays a harvest by its commits and the streak", () => {
    expect(harvestCoins(1, 1)).toBe(35);
    expect(harvestCoins(10, 1)).toBe(60);
    // JavaScript's 1+0.1*7 is 1.7000000000000002, and rounds as it does.
    expect(harvestCoins(0, 8)).toBe(51);
    expect(harvestCoins(0, 30)).toBe(60);
  });
});
