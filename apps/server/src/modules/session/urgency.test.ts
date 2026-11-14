import { describe, expect, it } from "vite-plus/test";

import { triggerOf } from "./payload.ts";
import { deliveryDraftOf, urgencyOf } from "./routing.ts";

const input = { source: "channel", actor: "user", recipient: "worker", event: "conversation", canSteer: true } as const;

describe("mailbox urgency", () => {
  it("keeps the routing table in one exhaustive rule", () => {
    expect(urgencyOf(input)).toBe("steer");
    expect(urgencyOf({ ...input, canSteer: false })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "agent", event: "mention", recipient: "orchestrator" })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "system", source: "github", event: "ci_failed", recipient: "orchestrator" })).toBe("digest");
    expect(urgencyOf({ ...input, actor: "agent", event: "report_attention", recipient: "orchestrator" })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "agent", event: "report_progress", recipient: "orchestrator" })).toBe("digest");
    expect(urgencyOf({ ...input, event: "stop" })).toBe("interrupt");
    expect(urgencyOf({ ...input, event: "stop", recipient: "orchestrator", busyWithChildren: true })).toBe("steer");
  });
});

describe("a routed trigger's delivery row", () => {
  const trigger = triggerOf({
    source: "github",
    key: "repo#7:ci",
    actor: { kind: "system", id: "ci" },
    text: "ci failed",
    threads: ["github:repo#7"],
    addressed: "thread_owner",
    meta: { kind: "ci", failed: true },
    at: 0,
  });

  it("answers where the trigger says, else in the session's channel, and counts in its issue's scope when it has one", () => {
    const row = deliveryDraftOf(trigger, { session: "w1" }, { channel: "general", role: "worker", at: 5 });
    expect([row.channel_id, row.scope, row.envelope_id, row.state, row.created_at]).toEqual(["general", "channel:general", trigger.id, "pending", 5]);
    const replied = deliveryDraftOf(
      { ...trigger, replyChannel: "room" },
      { session: "w1", issue: "i1", id: "returned:i1" },
      { channel: "general", role: "worker", at: 5 },
    );
    expect([replied.channel_id, replied.scope, replied.envelope_id, replied.payload.trigger.meta.issue]).toEqual(["room", "issue:i1", "returned:i1", "i1"]);
  });

  it("is as urgent as the session's role makes the event, and wakes it unless a digest, when the watch did not say", () => {
    const worker = deliveryDraftOf(trigger, { session: "w1" }, { channel: "general", role: "worker", at: 0 });
    expect([worker.urgency, worker.reason, worker.wakes, worker.held_by]).toEqual(["queue", "addressed", true, null]);
    const orchestrator = deliveryDraftOf(trigger, { session: "orchestrator" }, { channel: "general", role: "orchestrator", at: 0 });
    expect([orchestrator.urgency, orchestrator.wakes]).toEqual(["digest", false]);
    const heard = deliveryDraftOf(
      trigger,
      { session: "w1", urgency: "steer", heard: { reason: "mention", wakes: true, heldBy: "cooldown" } },
      { channel: "general", role: "worker", at: 0 },
    );
    expect([heard.urgency, heard.reason, heard.wakes, heard.held_by]).toEqual(["steer", "mention", true, "cooldown"]);
  });
});
