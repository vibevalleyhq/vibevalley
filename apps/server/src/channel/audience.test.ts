import { describe, expect, it } from "vite-plus/test";

import { Audience } from "./audience.ts";
const wake = { recipient: "w2", senderKind: "session", recipientKind: "session", wakes: true, held: false, at: 5 } as const;

describe("the audience", () => {
  it("counts agents waking agents since the owner last spoke, from the messages after their words", () => {
    const a = new Audience();
    a.load([], [{ channel_id: "c", n: 2 }], [], [{ channel_id: "c", id: "m10" }]);
    expect(a.hops("c")).toBe(2);
    a.delivered({ ...wake, channel: "c", message: "m11" });
    expect(a.hops("c")).toBe(3);
    a.ownerSpoke("c", "m12");
    expect(a.hops("c")).toBe(0);
    // Streamed from before the owner's words, it is finished after them: it does not count.
    a.delivered({ ...wake, channel: "c", message: "m11b" });
    expect(a.hops("c")).toBe(0);
    a.delivered({ ...wake, channel: "c", message: "m13" });
    // Held, not waking, the owner's, or to the owner: none count.
    a.delivered({ ...wake, channel: "c", message: "m14", held: true });
    a.delivered({ ...wake, channel: "c", message: "m15", wakes: false });
    a.delivered({ ...wake, channel: "c", message: "m16", senderKind: "owner" });
    a.delivered({ ...wake, channel: "c", message: "m17", recipientKind: "owner" });
    expect(a.hops("c")).toBe(1);
  });

  it("knows when an agent last woke each one, and who follows a thread", () => {
    const a = new Audience();
    a.load([{ channel_id: "t", participant_id: "w3" }], [], [{ recipient_id: "w2", at: 9 }], []);
    a.delivered({ ...wake, channel: "c", message: "m1", at: 4 });
    a.delivered({ ...wake, channel: "c", message: "m2", recipient: "w4", at: 12 });
    expect([a.lastWake("w2"), a.lastWake("w4"), a.lastWake("w5")]).toEqual([9, 12, 0]);
    a.followed("t", "w1");
    a.followed("t", "w3");
    expect(a.followers("t")).toEqual(["w1", "w3"]);
    expect(a.followers("other")).toEqual([]);
  });

  it("forgets a session that left", () => {
    const a = new Audience();
    a.load(
      [
        { channel_id: "t", participant_id: "w3" },
        { channel_id: "u", participant_id: "w3" },
        { channel_id: "u", participant_id: "w1" },
      ],
      [],
      [{ recipient_id: "w3", at: 9 }],
      [],
    );
    a.left("w3");
    expect([a.followers("t"), a.followers("u"), a.lastWake("w3")]).toEqual([[], ["w1"], 0]);
  });
});
