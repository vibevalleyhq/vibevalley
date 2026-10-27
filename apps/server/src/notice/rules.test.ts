import { type ChatMessage, ownerId, type WorkspaceState } from "@vibevalley/protocol";
import { describe, expect, it } from "vite-plus/test";
import { emptyWorkspaceState } from "../core/core.ts";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { emptyPatrol, forOwner, type PatrolNote, patrolStep } from "./rules.ts";

describe("the patrol", () => {
  // Every fifth round the farm is empty: what was hanging is forgotten.
  it("find for the patrol what was recorded", () => {
    const failed = checkCases(goldenCases("notice"), (c) => {
      if (c.fn !== "patrol") throw new Error(`unknown fn ${c.fn}`);
      const given = c.in as { state: WorkspaceState; nows: number[] };
      let memory = emptyPatrol();
      return given.nows.map((now, r) => {
        let report: PatrolNote[];
        [report, memory] = patrolStep(r % 5 === 4 ? emptyWorkspaceState() : given.state, now, memory);
        return {
          now,
          report: report.map((n) => ({ Key: n.key, Channel: n.channel ?? null, Text: n.text })),
          firstSeen: memory.firstSeen,
          reported: memory.reported,
        };
      });
    });
    expect(failed).toEqual([]);
  });
});

describe("what reaches the owner off the farm", () => {
  const said = (more: Partial<ChatMessage>): ChatMessage => ({
    id: "m",
    number: 1,
    channel: "c",
    from: "orchestrator",
    fromKind: "orchestrator",
    name: "管家",
    kind: "chat",
    text: "好",
    at: 0,
    revision: 1,
    ...more,
  });
  it("follows how much the place it is said in counts", () => {
    const named = said({ mentions: [ownerId] });
    expect([forOwner(said({})), forOwner(said({}), "mentions"), forOwner(named, "mentions"), forOwner(named, "none")]).toEqual([true, false, true, false]);
  });
});
