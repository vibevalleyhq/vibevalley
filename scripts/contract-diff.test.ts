import { describe, expect, it } from "vite-plus/test";

import { areaOf, isServiceLine, markdownOf, numstatOf, summaryOf } from "./contract-diff.ts";

describe("the contract diff", () => {
  it("counts the contract's lines apart, the areas touched, and the review's compression", () => {
    const changed = numstatOf(
      [
        "10\t2\tpackages/protocol/src/shapes.ts",
        "3\t0\tapps/server/db/migrations/0001_schema.up.sql",
        "-\t-\tapps/server/src/core/testdata/cases.jsonl.gz",
        "40\t20\tapps/server/src/issue/issue.ts",
        "5\t5\tapps/web/src/features/issue/Board.tsx",
      ].join("\n"),
    );
    const s = summaryOf(changed, 4);
    expect(s.total).toBe(85);
    expect(s.contract.map((c) => [c.kind, c.lines])).toEqual([
      ["protocol", 12],
      ["schema", 3],
      ["golden data", 0],
      ["service interfaces", 4],
    ]);
    expect(s.areas).toEqual(["apps/server", "packages/protocol", "server/core", "server/issue", "web/issue"]);
    expect(markdownOf(s)).toContain("85 lines changed; 19 of them in the contract (4.5 lines for each contract line).");
  });

  it("knows an area and a service's interface line", () => {
    expect([areaOf("apps/server/src/channel/chat.ts"), areaOf("apps/web/src/features/board/X.tsx"), areaOf("scripts/a.ts")]).toEqual([
      "server/channel",
      "web/board",
      "scripts",
    ]);
    expect([isServiceLine("    readonly list: () => Effect.Effect<T.Issue[]>;"), isServiceLine("const x = 1;")]).toEqual([true, false]);
  });
});
