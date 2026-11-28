import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  appendLedgerEntry,
  buildBaseRowCells,
  DEFAULT_PATROL_POLICY,
  detectPremiseFailure,
  evaluateExitPredicate,
  findDuplicateHypothesis,
  formatLedger,
  HILLCLIMB_POLICY,
  type LedgerEntry,
  parseLedger,
  PATROL_SENSORS,
  selectSensors,
  summarizeSensorOutput,
} from "./patrol.ts";

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  iter: 1,
  category: "arch",
  target: "crates/server/src/router.rs",
  hypothesis: "Remove unused pass-through helper",
  metricBefore: "131",
  metricAfter: "124",
  gate: "make verify-fast",
  verdict: "kept",
  note: "commit abc123",
  ...overrides,
});

describe("patrol ledger TSV serialization", () => {
  test("round-trips entries and sanitizes tabs and newlines", () => {
    const entries: LedgerEntry[] = [
      entry({ iter: 1, hypothesis: "Drop\tdead\nwrapper", note: "line1\nline2" }),
      entry({ iter: 2, verdict: "reverted", metricBefore: "24", metricAfter: "24", note: "" }),
      entry({ iter: 3, verdict: "needs-human", note: "touches HTTP v1 contract" }),
    ];
    const serialized = formatLedger(entries);
    const parsed = parseLedger(serialized);
    expect(parsed).toEqual([
      entry({ iter: 1, hypothesis: "Drop dead wrapper", note: "line1 line2" }),
      entry({ iter: 2, verdict: "reverted", metricBefore: "24", metricAfter: "24", note: "" }),
      entry({ iter: 3, verdict: "needs-human", note: "touches HTTP v1 contract" }),
    ]);
  });

  test("rejects malformed TSV rows with too few columns or bad verdict", () => {
    expect(() => parseLedger("iter\tcategory\n1\tarch\n")).toThrow(/expected 9 tab-separated columns/u);
    expect(() =>
      parseLedger("iter\tcategory\ttarget\thypothesis\tmetric_before\tmetric_after\tgate\tverdict\tnote\n1\ta\tb\tc\t1\t0\tg\tinvalid\tn\n"),
    ).toThrow();
  });
});

describe("exit predicate, deduplication, and Attack-the-Premise detector", () => {
  test("stops after maxConsecutiveReverts, resets on kept, ignores needs-human", () => {
    const streak = [
      entry({ iter: 1, verdict: "reverted" }),
      entry({ iter: 2, verdict: "needs-human" }),
      entry({ iter: 3, verdict: "reverted" }),
      entry({ iter: 4, verdict: "reverted" }),
    ];
    const plateau = evaluateExitPredicate(streak, DEFAULT_PATROL_POLICY);
    expect(plateau.shouldStop).toBe(true);
    expect(plateau.reason).toBe("revert_plateau");
    expect(plateau.consecutiveReverts).toBe(3);
    expect(plateau.needsHumanCount).toBe(1);

    const reset = [...streak.slice(0, 2), entry({ iter: 3, verdict: "kept" }), entry({ iter: 4, verdict: "reverted" })];
    const ongoing = evaluateExitPredicate(reset, DEFAULT_PATROL_POLICY);
    expect(ongoing.shouldStop).toBe(false);
    expect(ongoing.reason).toBe("continue");
    expect(ongoing.consecutiveReverts).toBe(1);
  });

  test("stops when kept count reaches hillclimb policy limit", () => {
    const sixKept = Array.from({ length: 6 }, (_, i) => entry({ iter: i + 1, verdict: "kept" }));
    const res = evaluateExitPredicate(sixKept, HILLCLIMB_POLICY);
    expect(res.shouldStop).toBe(true);
    expect(res.reason).toBe("kept_limit_reached");
    expect(res.keptCount).toBe(6);
  });

  test("detects duplicate hypotheses normalized by whitespace and case", () => {
    const prior = [entry({ iter: 2, target: "crates/core/src/note/base.rs", hypothesis: "Inline dead helper" })];
    expect(findDuplicateHypothesis(prior, "CRATES/CORE/SRC/NOTE/BASE.RS", "  inline   dead helper ")?.iter).toBe(2);
    expect(findDuplicateHypothesis(prior, "crates/core/src/note/doc.rs", "Inline dead helper")).toBeUndefined();
  });

  test("triggers Attack-the-Premise after 2 consecutive reverts on the same target and gate", () => {
    const target = "crates/server/src/issue/board.rs";
    const gate = "make rust-fast";
    const oneFail = [entry({ iter: 1, target, gate, verdict: "reverted" })];
    expect(detectPremiseFailure(oneFail, target, gate)).toBe(false);

    const twoFails = [...oneFail, entry({ iter: 2, target, gate, verdict: "reverted" })];
    expect(detectPremiseFailure(twoFails, target, gate)).toBe(true);

    const recovered = [...twoFails, entry({ iter: 3, target, gate, verdict: "kept" })];
    expect(detectPremiseFailure(recovered, target, gate)).toBe(false);
  });
});

describe("Base row payload and sensor parsing", () => {
  test("converts numeric metrics to BaseCellValue number cells and text metrics to text cells", () => {
    const cells = buildBaseRowCells(entry({ iter: 4, metricBefore: "131", metricAfter: "120" }), "i161");
    expect(cells.c_iter).toEqual({ _tag: "number", value: 4 });
    expect(cells.c_before).toEqual({ _tag: "number", value: 131 });
    expect(cells.c_after).toEqual({ _tag: "number", value: 120 });
    expect(cells.c_verdict).toEqual({ _tag: "text", value: "kept" });
    expect(cells.c_issue).toEqual({ _tag: "issueRef", issueId: "i161" });

    const textCells = buildBaseRowCells(entry({ metricBefore: "fail", metricAfter: "pass" }));
    expect(textCells.c_before).toEqual({ _tag: "text", value: "fail" });
    expect(textCells.c_issue).toBeUndefined();
  });

  test("selects fast vs full sensors and validates explicit sensor names", () => {
    expect(selectSensors("fast").map((s) => s.id)).toEqual(["deadcode", "xtask-audit", "ssot-check", "diagnose"]);
    expect(selectSensors("full").map((s) => s.id)).toEqual(["deadcode", "xtask-audit", "ssot-check", "diagnose", "dry", "crap"]);
    expect(selectSensors("fast", "diagnose,deadcode").map((s) => s.id)).toEqual(["diagnose", "deadcode"]);
    expect(() => selectSensors("fast", "nonexistent")).toThrow(/unknown sensor/u);
  });

  test("summarizes diagnose and ssot-check JSON outputs cleanly", () => {
    const diagnoseSpec = PATROL_SENSORS.find((s) => s.id === "diagnose")!;
    const diagRes = summarizeSensorOutput(
      diagnoseSpec,
      JSON.stringify({
        diagnostics: [{ rule: "lock-hotspot", file: "crates/server/src/a.rs", line: 12, why: "8 locks" }],
        hotspots: [{ module: "server::note", score: 91 }],
      }),
      "",
      0,
      45,
    );
    expect(diagRes.ok).toBe(true);
    expect(diagRes.findingCount).toBe(1);
    expect(diagRes.summary).toBe("1 diagnostics, 1 hotspots");
    expect(diagRes.topFindings[0]).toContain("lock-hotspot");

    const ssotSpec = PATROL_SENSORS.find((s) => s.id === "ssot-check")!;
    const ssotRes = summarizeSensorOutput(
      ssotSpec,
      JSON.stringify({ findings: [{ rule: "ssot-drift", file: "packages/protocol/src/x.ts", line: 4, why: "mismatch" }], duplicates: [{ id: 1 }] }),
      "",
      1,
      30,
    );
    expect(ssotRes.ok).toBe(false);
    expect(ssotRes.findingCount).toBe(2);
    expect(ssotRes.summary).toBe("1 drift findings, 1 duplicate groups");
  });
});

describe("patrol CLI end-to-end", () => {
  test("supports dry-run scan, record with --base-row, and status on a temp ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibevalley-patrol-"));
    const script = resolve(import.meta.dirname, "patrol.ts");
    const ledger = join(dir, "decisions.tsv");
    try {
      const scan = spawnSync(process.execPath, [script, "--", "scan", "--dry-run", "--json", "--ledger", ledger], { encoding: "utf8" });
      expect(scan.status).toBe(0);
      const scanJson = JSON.parse(scan.stdout) as { dryRun: boolean; sensors: { id: string }[] };
      expect(scanJson.dryRun).toBe(true);
      expect(scanJson.sensors.map((s) => s.id)).toEqual(["deadcode", "xtask-audit", "ssot-check", "diagnose"]);

      const rec = spawnSync(
        process.execPath,
        [
          script,
          "record",
          "--ledger",
          ledger,
          "--category",
          "deadcode",
          "--target",
          "scripts/foo.ts",
          "--hypothesis",
          "Drop dead export",
          "--before",
          "3",
          "--after",
          "2",
          "--gate",
          "vp run deadcode",
          "--verdict",
          "kept",
          "--base-row",
          "--json",
        ],
        { encoding: "utf8" },
      );
      expect(rec.status).toBe(0);
      const recJson = JSON.parse(rec.stdout) as { entry: LedgerEntry; baseRowCells: Record<string, unknown> };
      expect(recJson.entry.iter).toBe(1);
      expect(recJson.baseRowCells.c_after).toEqual({ _tag: "number", value: 2 });

      appendLedgerEntry(ledger, {
        category: "arch",
        target: "crates/server/src/x.rs",
        hypothesis: "Simplify lock",
        metricBefore: "10",
        metricAfter: "10",
        gate: "make rust-fast",
        verdict: "reverted",
        note: "failed test",
      });
      const status = spawnSync(process.execPath, [script, "status", "--ledger", ledger, "--json"], { encoding: "utf8" });
      expect(status.status).toBe(0);
      const statusJson = JSON.parse(status.stdout) as { evaluation: { keptCount: number; revertedCount: number } };
      expect(statusJson.evaluation.keptCount).toBe(1);
      expect(statusJson.evaluation.revertedCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
