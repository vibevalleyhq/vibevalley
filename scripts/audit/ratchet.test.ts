import { describe, expect, test } from "vite-plus/test";

import { grownRules, ratchetProblems, type RatchetWords } from "./ratchet.ts";

const words: RatchetWords = { write: "vp run health:write", see: "See x.md", cleared: () => 'Fix: set it to "error".' };

describe("a ratchet", () => {
  const kept = { globalJson: { "apps/server": 3, "packages/ai": 1 } };

  test("the same counts pass", () => {
    expect(ratchetProblems(kept, kept, words)).toEqual([]);
  });

  test("an area with more hits fails, and says the rule only goes down", () => {
    const now = { globalJson: { "apps/server": 4, "packages/ai": 1 } };
    const problems = ratchetProblems(kept, now, words);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^apps\/server has 4 globalJson \(kept 3\).*Fix: .*See /u);
    expect([...grownRules(kept, now)]).toEqual(["globalJson"]);
  });

  test("a hit in an area that had none fails", () => {
    expect(ratchetProblems(kept, { globalJson: { "apps/server": 3, "packages/ai": 1, "apps/web": 1 } }, words)).toHaveLength(1);
  });

  test("fewer hits fail too, until the ratchet is written down", () => {
    const problems = ratchetProblems(kept, { globalJson: { "apps/server": 2, "packages/ai": 1 } }, words);
    expect(problems).toEqual([expect.stringMatching(/down to 2 .*vp run health:write/u)]);
  });

  test("a rule with nothing left says what to do, when the check has something to say", () => {
    expect(ratchetProblems(kept, { globalJson: {} }, words).at(-1)).toMatch(/globalJson has no hits left anywhere\. Fix: set it to "error"/u);
    expect(ratchetProblems(kept, { globalJson: {} }, { write: "w", see: "s" }).some((p) => p.includes("no hits left"))).toBe(false);
  });
});
