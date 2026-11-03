import { describe, expect, it } from "vite-plus/test";

import { urgencyOf } from "./routing.ts";

const input = { source: "channel", actor: "owner", recipient: "worker", event: "conversation", canSteer: true } as const;

describe("mailbox urgency", () => {
  it("keeps the routing table in one exhaustive rule", () => {
    expect(urgencyOf(input)).toBe("steer");
    expect(urgencyOf({ ...input, canSteer: false })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "session", event: "mention", recipient: "orchestrator" })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "ci", source: "github", event: "ci_failed", recipient: "orchestrator" })).toBe("digest");
    expect(urgencyOf({ ...input, actor: "session", event: "report_attention", recipient: "orchestrator" })).toBe("queue");
    expect(urgencyOf({ ...input, actor: "session", event: "report_progress", recipient: "orchestrator" })).toBe("digest");
    expect(urgencyOf({ ...input, event: "stop" })).toBe("interrupt");
    expect(urgencyOf({ ...input, event: "stop", recipient: "orchestrator", busyWithChildren: true })).toBe("steer");
  });
});
