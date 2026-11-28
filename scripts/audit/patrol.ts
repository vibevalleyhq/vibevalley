import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");

export const DEFAULT_LEDGER_PATH = "/tmp/vv-patrol-decisions.tsv";

export const LEDGER_COLUMNS = ["iter", "category", "target", "hypothesis", "metric_before", "metric_after", "gate", "verdict", "note"] as const;

export const VerdictSchema = z.enum(["kept", "reverted", "needs-human"]);
export type PatrolVerdict = z.infer<typeof VerdictSchema>;

export interface LedgerEntry {
  readonly iter: number;
  readonly category: string;
  readonly target: string;
  readonly hypothesis: string;
  readonly metricBefore: string;
  readonly metricAfter: string;
  readonly gate: string;
  readonly verdict: PatrolVerdict;
  readonly note: string;
}

export interface ExitPolicy {
  readonly maxKept: number;
  readonly maxConsecutiveReverts: number;
}

export const DEFAULT_PATROL_POLICY: ExitPolicy = { maxKept: 8, maxConsecutiveReverts: 3 };
export const HILLCLIMB_POLICY: ExitPolicy = { maxKept: 6, maxConsecutiveReverts: 3 };

export interface ExitEvaluation {
  readonly shouldStop: boolean;
  readonly reason: "continue" | "kept_limit_reached" | "revert_plateau";
  readonly total: number;
  readonly keptCount: number;
  readonly revertedCount: number;
  readonly needsHumanCount: number;
  readonly consecutiveReverts: number;
}

export interface SensorSpec {
  readonly id: "deadcode" | "xtask-audit" | "ssot-check" | "diagnose" | "dry" | "crap";
  readonly profile: "fast" | "full";
  readonly cmd: string;
  readonly args: readonly string[];
  readonly description: string;
}

export const PATROL_SENSORS: readonly SensorSpec[] = [
  {
    id: "deadcode",
    profile: "fast",
    cmd: "vp",
    args: ["run", "deadcode"],
    description: "Unused TS files, exports, and dependencies (knip)",
  },
  {
    id: "xtask-audit",
    profile: "fast",
    cmd: "cargo",
    args: ["xtask", "audit"],
    description: "Rust module boundaries, ratchets, arch-audit, UML strict, UI deps, and SSOT",
  },
  {
    id: "ssot-check",
    profile: "fast",
    cmd: "cargo",
    args: ["xtask", "ssot-check", "--dupes", "--json"],
    description: "Rust <-> TS SSOT drift and cross-file structural duplicates",
  },
  {
    id: "diagnose",
    profile: "fast",
    cmd: "cargo",
    args: ["xtask", "diagnose", "--json", "--top", "10"],
    description: "Architectural hotspots (LOC, pub surface, fan-in/out, locks, diagnostics)",
  },
  {
    id: "dry",
    profile: "full",
    cmd: "cargo",
    args: ["xtask", "dry"],
    description: "Normalized structural clone scan across Rust and TypeScript",
  },
  {
    id: "crap",
    profile: "full",
    cmd: "cargo",
    args: ["xtask", "crap"],
    description: "Cyclomatic complexity & coverage CRAP hotspot ranking",
  },
];

export interface SensorResult {
  readonly id: SensorSpec["id"];
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly findingCount: number;
  readonly summary: string;
  readonly topFindings: readonly string[];
}

export type BaseCellWire =
  | { readonly _tag: "text"; readonly value: string }
  | { readonly _tag: "number"; readonly value: number }
  | { readonly _tag: "issueRef"; readonly issueId: string };

const sanitizeTsvField = (raw: string): string => raw.replaceAll("\t", " ").replaceAll(/\r?\n/gu, " ").trim();

export function formatLedger(entries: readonly LedgerEntry[]): string {
  const header = LEDGER_COLUMNS.join("\t");
  const rows = entries.map((e) =>
    [
      String(e.iter),
      sanitizeTsvField(e.category),
      sanitizeTsvField(e.target),
      sanitizeTsvField(e.hypothesis),
      sanitizeTsvField(e.metricBefore),
      sanitizeTsvField(e.metricAfter),
      sanitizeTsvField(e.gate),
      e.verdict,
      sanitizeTsvField(e.note),
    ].join("\t"),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

export function parseLedger(raw: string): LedgerEntry[] {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const startIndex = lines[0]?.startsWith("iter\t") === true ? 1 : 0;
  const entries: LedgerEntry[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const cols = (lines[i] ?? "").split("\t");
    if (cols.length < LEDGER_COLUMNS.length) {
      throw new Error(`patrol ledger line ${i + 1}: expected ${LEDGER_COLUMNS.length} tab-separated columns, got ${cols.length}`);
    }
    const iter = Number(cols[0]);
    if (!Number.isInteger(iter) || iter < 1) {
      throw new Error(`patrol ledger line ${i + 1}: invalid iter "${cols[0] ?? ""}"`);
    }
    const verdict = VerdictSchema.parse(cols[7]);
    entries.push({
      iter,
      category: cols[1] ?? "",
      target: cols[2] ?? "",
      hypothesis: cols[3] ?? "",
      metricBefore: cols[4] ?? "",
      metricAfter: cols[5] ?? "",
      gate: cols[6] ?? "",
      verdict,
      note: cols.slice(8).join(" "),
    });
  }
  return entries;
}

export function readLedgerFile(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8"));
}

export function appendLedgerEntry(path: string, entry: Omit<LedgerEntry, "iter">): { readonly entry: LedgerEntry; readonly entries: readonly LedgerEntry[] } {
  const existing = readLedgerFile(path);
  const nextIter = existing.reduce((max, row) => Math.max(max, row.iter), 0) + 1;
  const fullEntry: LedgerEntry = { iter: nextIter, ...entry };
  const updated = [...existing, fullEntry];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatLedger(updated), "utf8");
  return { entry: fullEntry, entries: updated };
}

export function evaluateExitPredicate(entries: readonly LedgerEntry[], policy: ExitPolicy = DEFAULT_PATROL_POLICY): ExitEvaluation {
  let keptCount = 0;
  let revertedCount = 0;
  let needsHumanCount = 0;
  let consecutiveReverts = 0;

  for (const entry of entries) {
    switch (entry.verdict) {
      case "kept":
        keptCount += 1;
        consecutiveReverts = 0;
        break;
      case "reverted":
        revertedCount += 1;
        consecutiveReverts += 1;
        break;
      case "needs-human":
        needsHumanCount += 1;
        break;
    }
  }

  if (keptCount >= policy.maxKept) {
    return {
      shouldStop: true,
      reason: "kept_limit_reached",
      total: entries.length,
      keptCount,
      revertedCount,
      needsHumanCount,
      consecutiveReverts,
    };
  }
  if (consecutiveReverts >= policy.maxConsecutiveReverts) {
    return {
      shouldStop: true,
      reason: "revert_plateau",
      total: entries.length,
      keptCount,
      revertedCount,
      needsHumanCount,
      consecutiveReverts,
    };
  }
  return {
    shouldStop: false,
    reason: "continue",
    total: entries.length,
    keptCount,
    revertedCount,
    needsHumanCount,
    consecutiveReverts,
  };
}

const normalizeKey = (value: string): string => value.trim().replaceAll(/\s+/gu, " ").toLowerCase();

export function findDuplicateHypothesis(entries: readonly LedgerEntry[], target: string, hypothesis: string): LedgerEntry | undefined {
  const targetKey = normalizeKey(target);
  const hypothesisKey = normalizeKey(hypothesis);
  return entries.find((e) => normalizeKey(e.target) === targetKey && normalizeKey(e.hypothesis) === hypothesisKey);
}

/** Triggers the Attack-the-Premise rule when the same (target, gate) failed twice in a row. */
export function detectPremiseFailure(entries: readonly LedgerEntry[], target: string, gate: string): boolean {
  const targetKey = normalizeKey(target);
  const gateKey = normalizeKey(gate);
  const matching = entries.filter((e) => normalizeKey(e.target) === targetKey && normalizeKey(e.gate) === gateKey && e.verdict !== "needs-human");
  if (matching.length < 2) return false;
  const lastTwo = matching.slice(-2);
  return lastTwo.every((e) => e.verdict === "reverted");
}

const parseFiniteNumber = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

/** Builds a `BaseUpsertRowRequest.cells` payload matching `crates/protocol/src/contract/note.rs` `BaseCellValue` (`_tag`). */
export function buildBaseRowCells(entry: LedgerEntry, issueId?: string): Record<string, BaseCellWire> {
  const beforeNum = parseFiniteNumber(entry.metricBefore);
  const afterNum = parseFiniteNumber(entry.metricAfter);
  const cells: Record<string, BaseCellWire> = {
    c_iter: { _tag: "number", value: entry.iter },
    c_category: { _tag: "text", value: entry.category },
    c_target: { _tag: "text", value: entry.target },
    c_hypothesis: { _tag: "text", value: entry.hypothesis },
    c_before: beforeNum !== undefined ? { _tag: "number", value: beforeNum } : { _tag: "text", value: entry.metricBefore },
    c_after: afterNum !== undefined ? { _tag: "number", value: afterNum } : { _tag: "text", value: entry.metricAfter },
    c_gate: { _tag: "text", value: entry.gate },
    c_verdict: { _tag: "text", value: entry.verdict },
    c_note: { _tag: "text", value: entry.note },
  };
  if (issueId !== undefined && issueId.trim() !== "") {
    cells.c_issue = { _tag: "issueRef", issueId: issueId.trim() };
  }
  return cells;
}

const JsonDiagnosticSchema = z.looseObject({
  rule: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string().optional(),
  why: z.string().optional(),
});

const DiagnoseJsonSchema = z.looseObject({
  diagnostics: z.array(JsonDiagnosticSchema).optional(),
  hotspots: z.array(z.looseObject({ module: z.string().optional(), path: z.string().optional(), score: z.number().optional() })).optional(),
});

const SsotJsonSchema = z.union([
  z.array(JsonDiagnosticSchema),
  z.looseObject({
    findings: z.array(JsonDiagnosticSchema).optional(),
    violations: z.array(JsonDiagnosticSchema).optional(),
    duplicates: z.array(z.unknown()).optional(),
  }),
]);

function extractJsonText(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const startObj = trimmed.indexOf("{");
    const startArr = trimmed.indexOf("[");
    const starts = [startObj, startArr].filter((idx) => idx >= 0);
    if (starts.length === 0) return undefined;
    const first = Math.min(...starts);
    try {
      return JSON.parse(trimmed.slice(first));
    } catch {
      return undefined;
    }
  }
}

export function summarizeSensorOutput(sensor: SensorSpec, stdout: string, stderr: string, exitCode: number, durationMs: number): SensorResult {
  const command = `${sensor.cmd} ${sensor.args.join(" ")}`;
  const combinedLines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  if (sensor.id === "diagnose") {
    const parsed = DiagnoseJsonSchema.safeParse(extractJsonText(stdout));
    if (parsed.success) {
      const diagnostics = parsed.data.diagnostics ?? [];
      const hotspots = parsed.data.hotspots ?? [];
      const topFindings = [
        ...diagnostics
          .slice(0, 5)
          .map((d) => `${d.rule ?? "diag"}: ${d.file ?? ""}${d.line !== undefined ? `:${d.line}` : ""} ${d.why ?? d.message ?? ""}`.trim()),
        ...hotspots.slice(0, 5).map((h) => `hotspot: ${h.module ?? h.path ?? "unknown"}${h.score !== undefined ? ` (score=${h.score})` : ""}`),
      ].slice(0, 5);
      return {
        id: sensor.id,
        command,
        ok: exitCode === 0,
        exitCode,
        durationMs,
        findingCount: diagnostics.length,
        summary: `${diagnostics.length} diagnostics, ${hotspots.length} hotspots`,
        topFindings,
      };
    }
  }

  if (sensor.id === "ssot-check") {
    const parsed = SsotJsonSchema.safeParse(extractJsonText(stdout));
    if (parsed.success) {
      const items = Array.isArray(parsed.data) ? parsed.data : (parsed.data.findings ?? parsed.data.violations ?? []);
      const dupesCount = Array.isArray(parsed.data) ? 0 : (parsed.data.duplicates?.length ?? 0);
      const count = items.length + dupesCount;
      const topFindings = items
        .slice(0, 5)
        .map((d) => `${d.rule ?? "ssot"}: ${d.file ?? ""}${d.line !== undefined ? `:${d.line}` : ""} ${d.why ?? d.message ?? ""}`.trim());
      return {
        id: sensor.id,
        command,
        ok: exitCode === 0 && count === 0,
        exitCode,
        durationMs,
        findingCount: count,
        summary: `${items.length} drift findings, ${dupesCount} duplicate groups`,
        topFindings,
      };
    }
  }

  const ok = exitCode === 0;
  const findingLines = ok ? [] : combinedLines.slice(0, 5);
  return {
    id: sensor.id,
    command,
    ok,
    exitCode,
    durationMs,
    findingCount: ok ? 0 : Math.max(1, findingLines.length),
    summary: ok ? (combinedLines.at(-1) ?? "ok") : (findingLines[0] ?? `exit ${exitCode}`),
    topFindings: findingLines,
  };
}

export function selectSensors(profile: "fast" | "full", explicitList?: string): readonly SensorSpec[] {
  if (explicitList !== undefined && explicitList.trim() !== "") {
    const wanted = explicitList
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const known = new Map<string, SensorSpec>(PATROL_SENSORS.map((s) => [s.id, s] as const));
    const selected: SensorSpec[] = [];
    for (const name of wanted) {
      const spec = known.get(name);
      if (spec === undefined) {
        throw new Error(`unknown sensor "${name}". Available: ${PATROL_SENSORS.map((s) => s.id).join(", ")}`);
      }
      selected.push(spec);
    }
    return selected;
  }
  return profile === "full" ? PATROL_SENSORS : PATROL_SENSORS.filter((s) => s.profile === "fast");
}

/** Runs selected sensors strictly sequentially so cargo never contends on target locks. */
export function runSensors(sensors: readonly SensorSpec[], cwd: string): SensorResult[] {
  const results: SensorResult[] = [];
  for (const sensor of sensors) {
    const started = Date.now();
    const run = spawnSync(sensor.cmd, [...sensor.args], { cwd, encoding: "utf8", shell: false });
    const durationMs = Date.now() - started;
    const exitCode = run.status ?? 1;
    const stderr = run.error ? `${run.error.message}\n${run.stderr ?? ""}` : (run.stderr ?? "");
    results.push(summarizeSensorOutput(sensor, run.stdout ?? "", stderr, exitCode, durationMs));
  }
  return results;
}

function usage(): string {
  return `Usage: vp run patrol -- <command> [options]

Commands:
  scan     Run deterministic repo sensors sequentially (never concurrent cargo)
           --profile fast|full  --sensors id1,id2  --ledger <path>  --dry-run  --json
  status   Show ledger summary and exit predicate status
           --ledger <path>  --max-kept <N>  --max-reverts <N>  --json
  record   Append one Keep/Revert/Needs-Human iteration to the out-of-tree ledger
           --ledger <path>  --category <cat>  --target <path>  --hypothesis <text>
           --before <val>   --after <val>     --gate <cmd>     --verdict kept|reverted|needs-human
           [--note <text>]  [--issue <id>]    [--base-row]     [--max-kept <N>]  [--max-reverts <N>]  [--json]

Available sensors: ${PATROL_SENSORS.map((s) => s.id).join(", ")}`;
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  return n;
}

export function runCli(argv: readonly string[], cwd: string = root): number {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [sub, ...rest] = normalized;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(usage());
    return 0;
  }

  switch (sub) {
    case "scan": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          profile: { type: "string", default: "fast" },
          sensors: { type: "string" },
          ledger: { type: "string", default: DEFAULT_LEDGER_PATH },
          "dry-run": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      const profile = values.profile === "full" ? "full" : values.profile === "fast" ? "fast" : undefined;
      if (profile === undefined) throw new Error(`--profile must be "fast" or "full", got "${values.profile}"`);
      const sensors = selectSensors(profile, values.sensors);
      const ledgerEntries = readLedgerFile(values.ledger);
      const exitStatus = evaluateExitPredicate(ledgerEntries);

      if (values["dry-run"]) {
        const plan = sensors.map((s) => ({ id: s.id, command: `${s.cmd} ${s.args.join(" ")}`, description: s.description }));
        if (values.json) {
          console.log(JSON.stringify({ dryRun: true, ledger: values.ledger, exitStatus, sensors: plan }, null, 2));
        } else {
          console.log(`patrol dry-run (${sensors.length} sequential sensors, ledger=${values.ledger}):`);
          for (const s of plan) console.log(`  - ${s.id}: ${s.command}`);
        }
        return 0;
      }

      const results = runSensors(sensors, cwd);
      const ranked = results.toSorted((a, b) => {
        const okDiff = Number(a.ok) - Number(b.ok);
        return okDiff !== 0 ? okDiff : b.findingCount - a.findingCount;
      });
      if (values.json) {
        console.log(JSON.stringify({ ledger: values.ledger, exitStatus, results: ranked }, null, 2));
      } else {
        console.log(`patrol scan (${results.length} sensors, kept=${exitStatus.keptCount}, consecutiveReverts=${exitStatus.consecutiveReverts}):`);
        for (const r of ranked) {
          console.log(`  [${r.ok ? "OK" : "TARGET"}] ${r.id} (${r.durationMs}ms): ${r.summary}`);
          for (const line of r.topFindings) console.log(`      ${line}`);
        }
      }
      return 0;
    }

    case "status": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          ledger: { type: "string", default: DEFAULT_LEDGER_PATH },
          "max-kept": { type: "string" },
          "max-reverts": { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const policy: ExitPolicy = {
        maxKept: parsePositiveInt(values["max-kept"], DEFAULT_PATROL_POLICY.maxKept, "--max-kept"),
        maxConsecutiveReverts: parsePositiveInt(values["max-reverts"], DEFAULT_PATROL_POLICY.maxConsecutiveReverts, "--max-reverts"),
      };
      const entries = readLedgerFile(values.ledger);
      const evaluation = evaluateExitPredicate(entries, policy);
      if (values.json) {
        console.log(JSON.stringify({ ledger: values.ledger, policy, evaluation, recent: entries.slice(-5) }, null, 2));
      } else {
        console.log(
          `patrol status (${values.ledger}): total=${evaluation.total} kept=${evaluation.keptCount}/${policy.maxKept} reverted=${evaluation.revertedCount} needs-human=${evaluation.needsHumanCount} consecutiveReverts=${evaluation.consecutiveReverts}/${policy.maxConsecutiveReverts} decision=${evaluation.reason}`,
        );
      }
      return 0;
    }

    case "record": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          ledger: { type: "string", default: DEFAULT_LEDGER_PATH },
          category: { type: "string" },
          target: { type: "string" },
          hypothesis: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          gate: { type: "string" },
          verdict: { type: "string" },
          note: { type: "string", default: "" },
          issue: { type: "string" },
          "base-row": { type: "boolean", default: false },
          "max-kept": { type: "string" },
          "max-reverts": { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const requiredField = (val: string | undefined, name: string): string => {
        if (val === undefined || val.trim() === "") throw new Error(`record requires --${name}`);
        return val;
      };
      const category = requiredField(values.category, "category");
      const target = requiredField(values.target, "target");
      const hypothesis = requiredField(values.hypothesis, "hypothesis");
      const metricBefore = requiredField(values.before, "before");
      const metricAfter = requiredField(values.after, "after");
      const gate = requiredField(values.gate, "gate");
      const verdict = VerdictSchema.parse(requiredField(values.verdict, "verdict"));
      const policy: ExitPolicy = {
        maxKept: parsePositiveInt(values["max-kept"], DEFAULT_PATROL_POLICY.maxKept, "--max-kept"),
        maxConsecutiveReverts: parsePositiveInt(values["max-reverts"], DEFAULT_PATROL_POLICY.maxConsecutiveReverts, "--max-reverts"),
      };

      const prior = readLedgerFile(values.ledger);
      const duplicate = findDuplicateHypothesis(prior, target, hypothesis);
      const { entry, entries } = appendLedgerEntry(values.ledger, {
        category,
        target,
        hypothesis,
        metricBefore,
        metricAfter,
        gate,
        verdict,
        note: values.note,
      });
      const evaluation = evaluateExitPredicate(entries, policy);
      const premiseAlert = detectPremiseFailure(entries, target, gate);
      const baseRowCells = values["base-row"] ? buildBaseRowCells(entry, values.issue) : undefined;

      if (values.json) {
        console.log(
          JSON.stringify(
            {
              ledger: values.ledger,
              entry,
              duplicatePriorIter: duplicate?.iter ?? null,
              premiseAlert,
              evaluation,
              ...(baseRowCells !== undefined ? { baseRowCells } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`patrol recorded #${entry.iter} [${entry.verdict}] ${entry.target}: ${entry.metricBefore} -> ${entry.metricAfter} (${evaluation.reason})`);
        if (duplicate !== undefined) {
          console.warn(`warning: duplicate hypothesis previously tried at iter #${duplicate.iter} (${duplicate.verdict})`);
        }
        if (premiseAlert) {
          console.warn(`warning: Attack the Premise — ${target} failed ${gate} twice in a row; stop patching and falsify the premise first.`);
        }
        if (baseRowCells !== undefined) {
          console.log(JSON.stringify({ cells: baseRowCells }, null, 2));
        }
      }
      return 0;
    }

    default:
      console.error(`patrol: unknown command "${sub}"\n\n${usage()}`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`patrol: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
