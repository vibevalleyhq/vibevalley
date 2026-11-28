import { spawn } from "node:child_process";
import { globSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";

interface SuiteResult {
  file: string;
  passed: number;
  failed: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface MacTestReport {
  generatedAt: string;
  concurrency: number;
  totalDurationMs: number;
  suites: SuiteResult[];
}

const root = resolve(import.meta.dirname, "../..");
const uiDir = resolve(root, "apps/mac/ui");
const nsh = resolve(root, ".tools/bin/nsh");
const defaultConcurrency = Math.min(12, Math.max(4, availableParallelism()));

// Schedule the slowest suites first (LPT) so the tail is bounded by the longest suite rather than starting it last.
const SLOW_SUITES: readonly string[] = ["workspace/workspace.test.tsx", "app/interactions.test.tsx", "app/scenarios.test.tsx", "app/theme.test.tsx"];

function suitePriority(file: string): number {
  const pinned = SLOW_SUITES.indexOf(file);
  if (pinned !== -1) return pinned;
  return file.endsWith(".test.tsx") ? SLOW_SUITES.length : SLOW_SUITES.length + 1;
}

function parseArgs(argv: string[]) {
  let concurrency = Number(process.env.MAC_TESTS_CONCURRENCY ?? defaultConcurrency);
  let filter = "";
  let reportPath = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--concurrency" && argv[i + 1]) {
      concurrency = Number(argv[++i]);
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = Number(arg.slice("--concurrency=".length));
    } else if (arg === "--filter" && argv[i + 1]) {
      filter = argv[++i] ?? "";
    } else if (arg.startsWith("--filter=")) {
      filter = arg.slice("--filter=".length);
    } else if (arg === "--report" && argv[i + 1]) {
      reportPath = argv[++i] ?? "";
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    }
  }
  const safeConcurrency = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : defaultConcurrency;
  return { concurrency: safeConcurrency, filter, reportPath };
}

function parseCounts(output: string, ok: boolean): { passed: number; failed: number } {
  let last: RegExpMatchArray | null = null;
  for (const m of output.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/gu)) {
    last = m;
  }
  if (last) {
    return { passed: Number(last[1]), failed: Number(last[2]) };
  }
  return { passed: 0, failed: ok ? 0 : 1 };
}

function runSuite(file: string): Promise<SuiteResult> {
  return new Promise((resolveSuite) => {
    const startedAt = Date.now();
    const child = spawn(nsh, ["test", file], { cwd: uiDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let combined = "";
    child.stdout.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolveSuite({
        file,
        passed: 0,
        failed: 1,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err.message,
      });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      const ok = code === 0;
      const counts = parseCounts(combined, ok);
      const result: SuiteResult = {
        file,
        passed: counts.passed,
        failed: counts.failed,
        durationMs,
        ok,
      };
      if (!ok) {
        result.error = combined.trim().split("\n").slice(-30).join("\n");
      }
      resolveSuite(result);
    });
  });
}

function runBatchSuites(concurrency: number): Promise<{ passed: number; failed: number; durationMs: number; ok: boolean; output: string }> {
  return new Promise((resolveBatch) => {
    const startedAt = Date.now();
    const child = spawn(nsh, ["test", ".", "-j", String(concurrency)], { cwd: uiDir, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let combined = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      combined += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      combined += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => {
      resolveBatch({ passed: 0, failed: 1, durationMs: Date.now() - startedAt, ok: false, output: err.message });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      const ok = code === 0;
      const counts = parseCounts(combined, ok);
      resolveBatch({ passed: counts.passed, failed: counts.failed, durationMs, ok, output: combined });
    });
  });
}

async function main() {
  const { concurrency, filter, reportPath } = parseArgs(process.argv.slice(2));
  if (!filter && !reportPath) {
    const batch = await runBatchSuites(concurrency);
    console.log(`mac-tests: batch (${batch.passed} passed, ${batch.failed} failed) in ${(batch.durationMs / 1000).toFixed(2)}s`);
    if (!batch.ok) {
      process.exit(1);
    }
    return;
  }
  const all = globSync(["**/*.test.ts", "**/*.test.tsx"], {
    cwd: uiDir,
    exclude: [".nsh/**", "build/**", "node_modules/**"],
  })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !filter || f.includes(filter))
    .toSorted((a, b) => {
      const diff = suitePriority(a) - suitePriority(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

  if (all.length === 0) {
    console.error("mac-tests: no headless test suites matched under apps/mac/ui");
    process.exit(1);
  }

  const startedAt = Date.now();
  const slots = Array.from<SuiteResult | undefined>({ length: all.length });
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, all.length) }, async () => {
    while (cursor < all.length) {
      const idx = cursor++;
      const file = all[idx];
      if (!file) continue;
      const res = await runSuite(file);
      slots[idx] = res;
      const secs = (res.durationMs / 1000).toFixed(2);
      const tag = res.ok ? "PASS" : "FAIL";
      console.log(`${tag} (${secs}s) ${res.file}: ${res.passed} passed, ${res.failed} failed`);
      if (!res.ok && res.error) {
        console.error(res.error);
      }
    }
  });
  await Promise.all(workers);

  const results = slots.filter((s): s is SuiteResult => s !== undefined);

  const totalDurationMs = Date.now() - startedAt;
  const totalPassed = results.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = results.reduce((sum, s) => sum + s.failed, 0);
  const failedSuites = results.filter((s) => !s.ok);

  if (reportPath) {
    const abs = resolve(root, reportPath);
    mkdirSync(dirname(abs), { recursive: true });
    const report: MacTestReport = {
      generatedAt: new Date().toISOString(),
      concurrency,
      totalDurationMs,
      suites: results,
    };
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(`mac-tests: ${results.length} suites (${totalPassed} passed, ${totalFailed} failed) in ${(totalDurationMs / 1000).toFixed(2)}s`);
  if (failedSuites.length > 0) {
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
