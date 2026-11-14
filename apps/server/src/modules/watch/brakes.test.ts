import { describe, expect, it, test } from "vite-plus/test";

import { brakes, type BrakeInput, hopLimit, Reach, WakeBreaker } from "./brakes.ts";
import { type ChannelAudience, whoHears } from "./hearers.ts";

const chatAudience = (input: ChannelAudience & BrakeInput) => brakes(whoHears(input), input);

describe("wake brakes", () => {
  it("applies hop, cooldown and breaker in priority order, while user inputs bypass them", () => {
    const deliveries = [
      { recipient: "w1", reason: "mention", wakes: true },
      { recipient: "w2", reason: "mention", wakes: true },
    ] as const;
    expect(
      brakes(deliveries, {
        actor: { kind: "agent", id: "w0", role: "worker" },
        orchestrators: [],
        hops: 4,
        cooling: ["w1"],
        broken: ["w1", "w2"],
      }),
    ).toEqual([
      { ...deliveries[0], heldBy: "hop_limit" },
      { ...deliveries[1], heldBy: "hop_limit" },
    ]);
    expect(
      brakes(deliveries, {
        actor: { kind: "agent", id: "w0", role: "worker" },
        orchestrators: [],
        hops: 0,
        cooling: ["w1"],
        broken: ["w2"],
      }),
    ).toEqual([
      { ...deliveries[0], heldBy: "cooldown" },
      { ...deliveries[1], heldBy: "wake_breaker" },
    ]);
    expect(brakes(deliveries, { actor: { kind: "user", id: "user" }, orchestrators: [], hops: 4, cooling: ["w1"], broken: ["w1", "w2"] })).toEqual(deliveries);
  });

  it("counts each wake it lets through as a hop, so one message waking many stops at the limit too", () => {
    const many = ["a", "b", "c"].map((recipient) => ({ recipient, reason: "mention" as const, wakes: true }));
    const held = brakes(many, { actor: { kind: "agent", id: "w0", role: "worker" }, orchestrators: [], hops: hopLimit - 2, cooling: [], broken: [] });
    expect(held.map((d) => d.heldBy ?? "")).toEqual(["", "", "hop_limit"]);
    // What does not wake is not braked, and takes no hop.
    const quiet = brakes([{ recipient: "a", reason: "channel", wakes: false }], {
      actor: { kind: "agent", id: "w0", role: "worker" },
      orchestrators: [],
      hops: hopLimit,
      cooling: ["a"],
      broken: ["a"],
    });
    expect(quiet).toEqual([{ recipient: "a", reason: "channel", wakes: false }]);
  });
});

describe("the wake breaker", () => {
  it("trips once after the limit, stays tripped through a word, and opens again when reset", () => {
    const b = new WakeBreaker(2);
    expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
    b.spoke("w1");
    expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
    expect(b.failed("w1")).toEqual({ count: 2, tripped: true });
    expect(b.failed("w1").tripped).toBe(false);
    b.spoke("w1");
    expect(b.tripped()).toEqual(["w1"]);
    expect(b.reset("w1")).toBe(true);
    expect([b.reset("w1"), b.tripped()]).toEqual([false, []]);
  });
});

describe("the reach", () => {
  it("counts agents' wakes in a place until the user speaks there", () => {
    const reach = new Reach();
    reach.load([{ scope: "c", n: 2 }], []);
    reach.woke("c", "w2", 5);
    expect(reach.hops("c")).toBe(3);
    reach.userSpoke("c");
    expect(reach.hops("c")).toBe(0);
    reach.woke("c", "w2", 6);
    expect([reach.hops("c"), reach.hops("elsewhere")]).toEqual([1, 0]);
  });

  it("cools down a session an agent's words woke, keeps the latest wake and forgets a departed session", () => {
    const reach = new Reach();
    reach.load([], [{ session: "w2", at: 9 }]);
    reach.woke("c", "w2", 4);
    reach.woke("c", "w4", 12);
    expect(reach.cooling(["w2", "w4", "w5"], 9 + 1000)).toEqual(["w2", "w4"]);
    expect(reach.cooling(["w2", "w4"], 9 + 60_000)).toEqual(["w4"]);
    reach.left("w2");
    expect(reach.cooling(["w2"], 10)).toEqual([]);
  });
});

test("with several orchestrators: the place's hears the user, and an orchestrator answering another is not cooled down", () => {
  const base: ChannelAudience & BrakeInput = {
    from: "user",
    actor: { kind: "user", id: "user" },
    kind: "chat",
    mentions: [],
    channel: { type: "channel" },
    orchestrator: "lead",
    channelMembers: ["lead"],
    orchestrators: ["orchestrator", "lead"],
    sessions: ["w1"],
    members: [],
    hops: 0,
    cooling: [],
    broken: [],
  };
  expect(chatAudience(base).map((d) => [d.recipient, d.reason, d.wakes])).toEqual([
    ["lead", "addressed", true],
    ["w1", "channel", false],
  ]);
  // No one in the channel: what the user says there to no one in particular wakes no one.
  expect(chatAudience({ ...base, channelMembers: [] })).toEqual([{ recipient: "w1", reason: "channel", wakes: false }]);
  expect(chatAudience({ ...base, mentions: ["orchestrator"] }).map((d) => [d.recipient, d.reason])).toEqual([
    ["orchestrator", "mention"],
    ["w1", "channel"],
  ]);
  expect(chatAudience({ ...base, channel: { type: "direct", peer: "lead" }, orchestrator: "lead" }).map((d) => d.recipient)).toEqual(["lead"]);
  // An orchestrator answering another is never cooled down, as a session would be.
  expect(
    chatAudience({ ...base, from: "orchestrator", actor: { kind: "agent", id: "orchestrator", role: "orchestrator" }, mentions: ["lead"], cooling: ["lead"] }),
  ).toEqual([{ recipient: "lead", reason: "mention", wakes: true }]);
});
