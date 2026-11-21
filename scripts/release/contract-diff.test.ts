import { describe, expect, it } from "vite-plus/test";

import { areaOf, isServiceLine, markdownOf, numstatOf, summaryOf } from "./contract-diff.ts";

describe("the contract diff", () => {
  it("counts the contract's lines apart, the areas touched, and the review's compression", () => {
    const changed = numstatOf(
      [
        "10\t2\tcrates/protocol/src/contract/issue.rs",
        "20\t5\tpackages/protocol/src/issue/shapes.gen.ts",
        "3\t0\tcrates/server/src/modules/work/issue/store.rs",
        "40\t15\tcrates/server/src/modules/work/issue/mod.rs",
        "5\t5\tapps/mac/ui/features/issue/Board.tsx",
      ].join("\n"),
    );
    const s = summaryOf(changed, 4);
    expect(s.total).toBe(105);
    expect(s.contract.map((c) => [c.kind, c.lines])).toEqual([
      ["protocol", 12],
      ["schema", 3],
      ["service interfaces", 4],
    ]);
    expect(s.areas).toEqual(["crates/protocol", "mac/issue", "packages/protocol", "server/issue"]);
    expect(markdownOf(s)).toContain("105 lines changed; 19 of them in the contract (5.5 lines for each contract line).");
  });

  it("knows an area and a service's interface line", () => {
    expect([
      areaOf("crates/server/src/modules/collab/channel/mod.rs"),
      areaOf("apps/mac/ui/features/board/X.tsx"),
      areaOf("crates/cli/src/main.rs"),
      areaOf("scripts/a.ts"),
    ]).toEqual(["server/channel", "mac/board", "crates/cli", "scripts"]);
    expect([isServiceLine("    pub fn record_pull_request(&self, id: &str) -> Result<(), ApiError> {"), isServiceLine("    let x = 1;")]).toEqual([
      true,
      false,
    ]);
  });
});
