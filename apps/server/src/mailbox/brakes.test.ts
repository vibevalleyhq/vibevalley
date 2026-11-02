import { describe, expect, it } from "vite-plus/test";

import { brakes } from "./brakes.ts";

describe("mailbox wake brakes", () => {
  it("applies hop, cooldown and breaker in priority order, while owner inputs bypass them", () => {
    const deliveries = [
      { recipient: "w1", reason: "mention", wakes: true },
      { recipient: "w2", reason: "mention", wakes: true },
    ] as const;
    expect(brakes(deliveries, { fromKind: "session", orchestrators: [], hops: 4, cooling: ["w1"], broken: ["w1", "w2"] })).toEqual([
      { ...deliveries[0], heldBy: "hop_limit" },
      { ...deliveries[1], heldBy: "hop_limit" },
    ]);
    expect(brakes(deliveries, { fromKind: "session", orchestrators: [], hops: 0, cooling: ["w1"], broken: ["w2"] })).toEqual([
      { ...deliveries[0], heldBy: "cooldown" },
      { ...deliveries[1], heldBy: "wake_breaker" },
    ]);
    expect(brakes(deliveries, { fromKind: "owner", orchestrators: [], hops: 4, cooling: ["w1"], broken: ["w1", "w2"] })).toEqual(deliveries);
  });
});
