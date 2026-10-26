import { describe, expect, it } from "vite-plus/test";
import { Deliveries, type DeliveryRow } from "./deliveries.ts";

const row = (message: string, number: number, conversation = "c"): DeliveryRow => ({
  message_id: message,
  number,
  reason: "channel",
  wakes: true,
  held_by: null,
  state: "pending",
  launch: null,
  conversation_id: conversation,
  sender_id: "user",
  kind: "chat",
  body: "话",
  created_at: 1,
  name: "主人",
  sender_kind: "user",
  conversation_kind: "general",
  parent_id: null,
  parent_number: null,
  subject_kind: null,
  subject_id: null,
  channel_name: "田头",
});

const states = (d: Deliveries, who: string) => d.of(who).map((r) => [r.message_id, r.state, r.launch]);

describe("the open deliveries", () => {
  it("move pending → announced → handed, go back when a launch closes, and leave once seen", () => {
    const d = new Deliveries();
    d.load([{ ...row("m2", 2), recipient_id: "w1" }]);
    d.inserted("w1", row("m1", 1));
    d.inserted("w1", { ...row("m1", 1), body: "again" });
    expect(d.of("w1").map((r) => r.body)).toEqual(["话", "话"]);
    d.announced("w1", "m1", "L1");
    d.handed("w1", "m2", "L1");
    expect(states(d, "w1")).toEqual([
      ["m1", "announced", "L1"],
      ["m2", "handed", "L1"],
    ]);
    // Handed is not announced again.
    d.announced("w1", "m2", "L2");
    d.announcedBack("w1", "L1");
    d.handedBack("w1");
    expect(states(d, "w1")).toEqual([
      ["m1", "pending", null],
      ["m2", "pending", null],
    ]);
    d.seen("w1", "m1");
    expect(states(d, "w1")).toEqual([["m2", "pending", null]]);
  });

  it("read up to a number in one conversation, or dropped whole", () => {
    const d = new Deliveries();
    for (const [m, n, c] of [
      ["a1", 1, "a"],
      ["a2", 2, "a"],
      ["b1", 1, "b"],
    ] as const)
      d.inserted("w1", row(m, n, c));
    d.seenUpTo("w1", "a", 1);
    expect(d.of("w1").map((r) => r.message_id)).toEqual(["a2", "b1"]);
    d.dropped("w1");
    expect(d.of("w1")).toEqual([]);
  });
});
