import type { CoreState } from "@vibevalley/protocol";
import { emptyCoreState } from "@vibevalley/protocol/rules";
import { describe, expect, it } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { emptyPatrol, type PatrolNote, patrolStep } from "./rules.ts";

describe("the patrol", () => {
  // Every fifth round the farm is empty: what was hanging is forgotten.
  it("find for the patrol what was recorded", () => {
    const failed = checkCases(goldenCases("notice"), (c) => {
      if (c.fn !== "patrol") throw new Error(`unknown fn ${c.fn}`);
      const given = c.in as { state: CoreState; nows: number[] };
      let memory = emptyPatrol();
      return given.nows.map((now, r) => {
        let report: PatrolNote[];
        [report, memory] = patrolStep(r % 5 === 4 ? emptyCoreState() : given.state, now, memory);
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
