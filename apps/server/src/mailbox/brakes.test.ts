import { describe, expect, it } from "vite-plus/test";

import { brakes, Reach, WakeBreaker } from "./brakes.ts";

describe("mailbox wake brakes", () => {
  it("applies hop, cooldown and breaker in priority order, while owner inputs bypass them", () => {
    const deliveries = [
      { recipient: "w1", reason: "mention", wakes: true },
      { recipient: "w2", reason: "mention", wakes: true },
    ] as const;
    expect(brakes(deliveries, { fromKind: "agent", orchestrators: [], hops: 4, cooling: ["w1"], broken: ["w1", "w2"] })).toEqual([
      { ...deliveries[0], heldBy: "hop_limit" },
      { ...deliveries[1], heldBy: "hop_limit" },
    ]);
    expect(brakes(deliveries, { fromKind: "agent", orchestrators: [], hops: 0, cooling: ["w1"], broken: ["w2"] })).toEqual([
      { ...deliveries[0], heldBy: "cooldown" },
      { ...deliveries[1], heldBy: "wake_breaker" },
    ]);
    expect(brakes(deliveries, { fromKind: "owner", orchestrators: [], hops: 4, cooling: ["w1"], broken: ["w1", "w2"] })).toEqual(deliveries);
  });
});

describe("mailbox wake breaker", () => {
  it("trips once after the limit, stays tripped through a word, and opens again when reset", () => {
    const b = new WakeBreaker(2);
    expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
    b.spoke("w1");
    expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
    expect(b.failed("w1")).toEqual({ count: 2, tripped: true });
    expect(b.failed("w1").tripped).toBe(false);
    b.spoke("w1");
    expect([b.isOpen("w1"), b.tripped()]).toEqual([true, ["w1"]]);
    b.reset("w1");
    expect([b.isOpen("w1"), b.tripped()]).toEqual([false, []]);
  });
});

const wake = { session: "w2", senderKind: "agent", wakes: true, held: false, at: 5 } as const;

describe("mailbox reach", () => {
  it("counts agent wakes after the owner's newest receipt", () => {
    const reach = new Reach();
    reach.load([{ scope: "c", n: 2 }], [], [{ scope: "c", position: 10 }]);
    reach.delivered({ ...wake, scope: "c", position: 11 });
    expect(reach.hops("c")).toBe(3);
    reach.ownerSpoke("c", 12);
    reach.delivered({ ...wake, scope: "c", position: 11 });
    expect(reach.hops("c")).toBe(0);
    reach.delivered({ ...wake, scope: "c", position: 13 });
    expect(reach.hops("c")).toBe(1);
    reach.ownerSpoke("c", 10);
    expect(reach.hops("c")).toBe(1);
  });

  it("keeps the latest wake and forgets a departed Session", () => {
    const reach = new Reach();
    reach.load([], [{ session_id: "w2", at: 9 }], []);
    reach.delivered({ ...wake, scope: "c", position: 1, at: 4 });
    reach.delivered({ ...wake, scope: "c", position: 2, session: "w4", at: 12 });
    expect([reach.lastWake("w2"), reach.lastWake("w4")]).toEqual([9, 12]);
    reach.left("w2");
    expect(reach.lastWake("w2")).toBe(0);
  });
});
