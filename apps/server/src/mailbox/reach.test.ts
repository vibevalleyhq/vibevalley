import { describe, expect, it } from "vite-plus/test";

import { Reach } from "./reach.ts";

const wake = { session: "w2", senderKind: "session", wakes: true, held: false, at: 5 } as const;

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
