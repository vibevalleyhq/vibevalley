import { Formatter } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { Deliveries, type DeliveryRow } from "./deliveries.ts";
const row = (message: string, number: number, channel = "c", position = number): DeliveryRow => ({
  envelope_id: message,
  scope: `channel:${channel}`,
  position,
  message_id: message,
  source: "channel",
  urgency: "queue",
  reason: "channel",
  wakes: true,
  held_by: null,
  state: "pending",
  launch: null,
  channel_id: channel,
  created_at: 1,
  payload: {
    trigger: {
      id: message,
      source: "channel",
      actor: { kind: "user", id: "user", name: "用户" },
      addressed: "direct",
      threads: [`channel:${channel}`],
      card: { summary: "话", totalChars: 1, truncated: false, readUri: `vv://trigger/${message}` },
      meta: {},
      at: 1,
    },
    context: { number, target: channel },
    channelType: "channel",
  },
});

const states = (d: Deliveries, who: string) => d.of(who).map((r) => [r.envelope_id, r.state, r.launch]);

describe("the open deliveries", () => {
  it("move pending → handed, go back when a launch closes, and leave once seen", () => {
    const d = new Deliveries();
    const { payload, ...stored } = row("m2", 2);
    d.load([{ ...stored, session_id: "w1", payload_json: Formatter.formatJson(payload) }]);
    d.inserted("w1", row("m1", 1));
    d.inserted("w1", { ...row("m1", 1), payload: row("another", 3).payload });
    expect(d.of("w1").map((r) => r.payload.trigger.card.summary)).toEqual(["话", "话"]);
    d.handed("w1", "m2", "L1");
    expect(states(d, "w1")).toEqual([
      ["m1", "pending", null],
      ["m2", "handed", "L1"],
    ]);
    d.handed("w1", "m2", "L2");
    expect(states(d, "w1")[1]).toEqual(["m2", "handed", "L1"]);
    d.handedBack("w1");
    expect(states(d, "w1")).toEqual([
      ["m1", "pending", null],
      ["m2", "pending", null],
    ]);
    d.remove("w1", "m1");
    expect(states(d, "w1")).toEqual([["m2", "pending", null]]);
  });

  it("removes one receipt without touching other channels, or drops a whole session", () => {
    const d = new Deliveries();
    for (const [m, n, c, position] of [
      ["a1", 1, "a", 1],
      ["a2", 2, "a", 2],
      ["b1", 1, "b", 3],
    ] as const)
      d.inserted("w1", row(m, n, c, position));
    d.remove("w1", "a1");
    expect(d.of("w1").map((r) => r.envelope_id)).toEqual(["a2", "b1"]);
    d.dropped("w1");
    expect(d.of("w1")).toEqual([]);
  });
});

it("regression: delivery positions order opaque IDs independently of source timestamps", () => {
  const deliveries = new Deliveries();
  deliveries.inserted("w1", { ...row("aaa", 1, "a", 2), created_at: 1 });
  deliveries.inserted("w1", { ...row("zzz", 1, "b", 1), created_at: 500 });
  expect(deliveries.of("w1").map((item) => item.envelope_id)).toEqual(["zzz", "aaa"]);
});
