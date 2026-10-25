import type { WorkspaceState, Fact, LedgerEntry } from "@vibevalley/protocol";
import { reduce } from "../projection/reduce.ts";
import { describe, expect, it } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { catchUp, emptyFolded, entriesFor, harvestCoins, progressFold, progressStep } from "./progress.ts";

describe("the ledger's fold", () => {
  // Step by step, and the entries each fact makes, over the recorded cases.
  it("pays and unlocks as recorded", () => {
    const failed = checkCases(goldenCases("game"), (c) => {
      switch (c.fn) {
        case "ledger": {
          const { entries } = c.in as { entries: LedgerEntry[] };
          let folded = emptyFolded();
          const steps = entries.map((e) => {
            const [next, news] = progressStep(folded, e);
            folded = next;
            const p = folded.progress;
            return { coins: p.coins, streak: p.streak, title: p.title ?? null, news };
          });
          expect(progressFold(entries).progress).toEqual(folded.progress);
          return { steps, progress: folded.progress, seen: folded.seen };
        }
        case "entries": {
          const given = c.in as { before: WorkspaceState; fact: Fact };
          const [after] = reduce(given.before, given.fact);
          return {
            entries: entriesFor(given.before, given.fact, after),
            catchUp: catchUp(given.before),
          };
        }
      }
      throw new Error(`unknown fn ${c.fn}`);
    });
    expect(failed).toEqual([]);
  });

  it("pays a harvest by its commits and the streak", () => {
    expect(harvestCoins(1, 1)).toBe(35);
    expect(harvestCoins(10, 1)).toBe(60);
    // JavaScript's 1+0.1*7 is 1.7000000000000002, and rounds as it does.
    expect(harvestCoins(0, 8)).toBe(51);
    expect(harvestCoins(0, 30)).toBe(60);
  });
});
