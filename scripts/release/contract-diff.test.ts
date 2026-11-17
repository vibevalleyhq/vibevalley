import { describe, expect, it } from "vite-plus/test";

import { areaOf, isServiceLine, markdownOf, numstatOf, summaryOf } from "./contract-diff.ts";

describe("the contract diff", () => {
  it("counts the contract's lines apart, the areas touched, and the review's compression", () => {
    const changed = numstatOf(
      [
        "10\t2\tpackages/protocol/src/shapes.ts",
        "3\t0\tinternal/domain/issue/migrations/0001_init.up.sql",
        "40\t20\tinternal/domain/issue/service.go",
        "5\t5\tapps/web/src/features/issue/Board.tsx",
      ].join("\n"),
    );
    const s = summaryOf(changed, 4);
    expect(s.total).toBe(85);
    expect(s.contract.map((c) => [c.kind, c.lines])).toEqual([
      ["protocol", 12],
      ["schema", 3],
      ["service interfaces", 4],
    ]);
    expect(s.areas).toEqual(["domain/issue", "packages/protocol", "web/issue"]);
    expect(markdownOf(s)).toContain("85 lines changed; 19 of them in the contract (4.5 lines for each contract line).");
  });

  it("knows an area and a service's interface line", () => {
    expect([areaOf("internal/domain/channel/channel.go"), areaOf("apps/web/src/features/board/X.tsx"), areaOf("scripts/a.ts")]).toEqual([
      "domain/channel",
      "web/board",
      "scripts",
    ]);
    expect([isServiceLine("type Service interface {"), isServiceLine("const x = 1;")]).toEqual([true, false]);
  });
});
