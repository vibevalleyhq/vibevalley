import { describe, expect, test } from "vite-plus/test";

import { ratchetProblems } from "./effect-check.ts";

describe("the Effect diagnostics ratchet", () => {
  const kept = { globalJson: { "apps/server": 3, "packages/ai": 1 } };

  test("the same counts pass", () => {
    expect(ratchetProblems(kept, kept)).toEqual([]);
  });

  test("a project with more hits fails, and says the rule only goes down", () => {
    const problems = ratchetProblems(kept, { globalJson: { "apps/server": 4, "packages/ai": 1 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^apps\/server has 4 globalJson \(kept 3\).*Fix: .*See /u);
  });

  test("a hit in a project that had none fails", () => {
    expect(ratchetProblems(kept, { globalJson: { "apps/server": 3, "packages/ai": 1, "apps/web": 1 } })).toHaveLength(1);
  });

  test("fewer hits fail too, until the ratchet is written down", () => {
    const problems = ratchetProblems(kept, { globalJson: { "apps/server": 2, "packages/ai": 1 } });
    expect(problems).toEqual([expect.stringMatching(/down to 2 .*vp run effect:write/u)]);
  });

  test("a rule with nothing left is to be turned on", () => {
    const problems = ratchetProblems(kept, { globalJson: {} });
    expect(problems.at(-1)).toMatch(/globalJson has no hits left anywhere\. Fix: set it to "error"/u);
  });
});
