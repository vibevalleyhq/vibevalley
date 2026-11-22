import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

export const DEFAULT_SCENARIOS = ["typical", "edge"] as const;
export type GalleryScenario = (typeof DEFAULT_SCENARIOS)[number];

const HostedDumpSchema = z.object({
  ready: z.boolean().optional(),
  errors: z.array(z.string()).default([]),
});

const DumpSchema = z.object({
  loaded: z.boolean(),
  load_error: z.string().nullable().default(null),
  sidebar: HostedDumpSchema.optional(),
  workbench: HostedDumpSchema.optional(),
  palette: z
    .object({
      view: HostedDumpSchema.optional(),
    })
    .nullable()
    .optional(),
  projects: z
    .array(
      z.object({
        tabs: z
          .array(
            z.object({
              hosted: HostedDumpSchema.optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export interface GalleryOptions {
  readonly outDir: string;
  readonly skipBuild: boolean;
  readonly scenarios: readonly GalleryScenario[];
}

export function isGalleryScenario(value: string): value is GalleryScenario {
  return value === "typical" || value === "edge";
}

export function parseGalleryArgs(argv: readonly string[], cwd = process.cwd()): GalleryOptions {
  let outDir = "/tmp/vv-ui-report";
  let skipBuild = false;
  let scenarios: GalleryScenario[] = [...DEFAULT_SCENARIOS];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--out" && argv[i + 1]) {
      outDir = resolve(cwd, argv[++i] ?? outDir);
    } else if (arg.startsWith("--out=")) {
      outDir = resolve(cwd, arg.slice("--out=".length));
    } else if (arg === "--scenarios" && argv[i + 1]) {
      scenarios = parseScenarioList(argv[++i] ?? "");
    } else if (arg.startsWith("--scenarios=")) {
      scenarios = parseScenarioList(arg.slice("--scenarios=".length));
    }
  }

  return { outDir, skipBuild, scenarios };
}

function parseScenarioList(raw: string): GalleryScenario[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("--scenarios requires at least one scenario (typical, edge)");
  const out: GalleryScenario[] = [];
  for (const part of parts) {
    if (!isGalleryScenario(part)) {
      throw new Error(`unsupported gallery scenario "${part}" (supported: ${DEFAULT_SCENARIOS.join(", ")})`);
    }
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

export interface GalleryStepPlan {
  readonly steps: readonly string[];
  readonly expectedShots: readonly string[];
}

function shotLine(shotsDir: string, name: string, expected: string[]): string {
  const file = resolve(shotsDir, `${name}.png`);
  expected.push(file);
  return JSON.stringify({ shell: `shot:${file}` });
}

function routeStep(path: string): string {
  return JSON.stringify({ type: "open_route", path });
}

export function buildStepPlan(scenario: GalleryScenario, shotsDir: string): GalleryStepPlan {
  const expected: string[] = [];
  const wait = (ms: number) => JSON.stringify({ shell: `wait:${ms}` });
  const resize = (w: number, h: number) => JSON.stringify({ shell: `resize:${w},${h}` });
  const toggleTheme = JSON.stringify({ shell: "toggle_theme" });
  const draw = JSON.stringify({ shell: "draw" });
  const quit = JSON.stringify({ shell: "quit" });

  if (scenario === "typical") {
    const steps = [
      resize(1280, 820),
      routeStep("/issues"),
      wait(900),
      draw,
      shotLine(shotsDir, "typical-issues-light", expected),
      toggleTheme,
      wait(400),
      draw,
      shotLine(shotsDir, "typical-issues-dark", expected),
      toggleTheme,
      resize(560, 820),
      wait(500),
      draw,
      shotLine(shotsDir, "typical-issues-narrow-light", expected),
      resize(1280, 820),
      routeStep("/chat"),
      wait(800),
      draw,
      shotLine(shotsDir, "typical-chat-light", expected),
      routeStep("/runs"),
      wait(700),
      draw,
      shotLine(shotsDir, "typical-runs-light", expected),
      routeStep("/agents"),
      wait(700),
      draw,
      shotLine(shotsDir, "typical-agents-light", expected),
      routeStep("/pkm"),
      wait(700),
      draw,
      shotLine(shotsDir, "typical-pkm-light", expected),
      routeStep("/artifacts/art-launch-board"),
      wait(1100),
      draw,
      shotLine(shotsDir, "typical-whiteboard-light", expected),
      toggleTheme,
      wait(500),
      draw,
      shotLine(shotsDir, "typical-whiteboard-dark", expected),
      toggleTheme,
      routeStep("/settings/general"),
      wait(700),
      draw,
      shotLine(shotsDir, "typical-settings-light", expected),
      routeStep("/workspace"),
      wait(900),
      draw,
      shotLine(shotsDir, "typical-workspace-light", expected),
      toggleTheme,
      wait(400),
      draw,
      shotLine(shotsDir, "typical-workspace-dark", expected),
      toggleTheme,
      routeStep("/farm"),
      wait(900),
      draw,
      shotLine(shotsDir, "typical-farm", expected),
      routeStep("/issues"),
      wait(1200),
      quit,
    ];
    return { steps, expectedShots: expected };
  }

  const steps = [
    resize(1280, 820),
    routeStep("/issues"),
    wait(900),
    draw,
    shotLine(shotsDir, "edge-issues-light", expected),
    toggleTheme,
    wait(400),
    draw,
    shotLine(shotsDir, "edge-issues-dark", expected),
    toggleTheme,
    routeStep("/library"),
    wait(800),
    draw,
    shotLine(shotsDir, "edge-library-light", expected),
    wait(1200),
    quit,
  ];
  return { steps, expectedShots: expected };
}

export function validateDumpAndShots(
  scenario: string,
  rawDump: unknown,
  expectedShots: readonly string[],
  fileSizeOf: (path: string) => number | null = (path) => (existsSync(path) ? statSync(path).size : null),
): string[] {
  const problems: string[] = [];
  const parsed = DumpSchema.safeParse(rawDump);
  if (!parsed.success) {
    return [`${scenario}: invalid dump.json (${parsed.error.issues.map((i) => i.message).join("; ")})`];
  }
  const dump = parsed.data;
  if (!dump.loaded) problems.push(`${scenario}: shell.loaded is false`);
  if (dump.load_error !== null) problems.push(`${scenario}: load_error: ${dump.load_error}`);
  if ((dump.sidebar?.errors.length ?? 0) > 0) problems.push(`${scenario}: sidebar errors: ${dump.sidebar?.errors.join("; ") ?? ""}`);
  if ((dump.workbench?.errors.length ?? 0) > 0) problems.push(`${scenario}: workbench errors: ${dump.workbench?.errors.join("; ") ?? ""}`);
  if ((dump.palette?.view?.errors.length ?? 0) > 0) problems.push(`${scenario}: palette errors: ${dump.palette?.view?.errors.join("; ") ?? ""}`);
  for (const project of dump.projects) {
    for (const tab of project.tabs) {
      if ((tab.hosted?.errors.length ?? 0) > 0) {
        problems.push(`${scenario}: pane hosted errors: ${tab.hosted?.errors.join("; ") ?? ""}`);
      }
    }
  }
  for (const shot of expectedShots) {
    const size = fileSizeOf(shot);
    if (size === null || size <= 0) {
      problems.push(`${scenario}: missing or empty screenshot ${shot}`);
    }
  }
  return problems;
}

export function parseScenarioMatrixStdout(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const idx = line.indexOf("@@SCENARIO_MATRIX ");
    if (idx >= 0) {
      return line.slice(idx + "@@SCENARIO_MATRIX ".length).trim();
    }
  }
  return null;
}

function runChecked(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean }): string {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.status !== 0) {
    const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
    const stdout = typeof res.stdout === "string" ? res.stdout.trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(res.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

function writeScenarioResponses(root: string, scenario: GalleryScenario, outPath: string): void {
  const raw = readFileSync(resolve(root, "apps/mac/ui/fixtures/workbench/responses.json"), "utf8");
  if (scenario !== "typical") {
    writeFileSync(outPath, raw, "utf8");
    return;
  }
  const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  const list = parsed["artifact.list"];
  if (Array.isArray(list)) {
    const board: unknown = list.find((a) => typeof a === "object" && a !== null && "id" in a && a.id === "art-launch-board");
    if (board !== undefined) {
      parsed["artifact.get"] = board;
    }
  }
  writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function runGallery(): void {
  const root = resolve(import.meta.dirname, "../..");
  const options = parseGalleryArgs(process.argv.slice(2));
  const shotsDir = resolve(options.outDir, "shots");
  const fakeRoot = resolve(options.outDir, "fake");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(fakeRoot, { recursive: true });

  const uiBundle = resolve(root, "apps/mac/ui/build/bundle.nshc");
  const nshBin = resolve(root, ".tools/bin/nsh");
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
  const macBin = resolve(targetDir, "debug/vibevalley-mac");

  if (!options.skipBuild || !existsSync(uiBundle)) {
    runChecked(nshBin, ["build", "App.tsx", "-o", "build"], { cwd: resolve(root, "apps/mac/ui") });
  }
  if (!options.skipBuild || !existsSync(macBin)) {
    runChecked("cargo", ["build", "-p", "vibevalley-mac", "--features", "shot"], { cwd: root });
  }

  runChecked("vpx", ["scripts/audit/mac-tests.ts", "--report", resolve(options.outDir, "all-ui.json")], { cwd: root });

  const matrixOut = runChecked(nshBin, ["test", "app/scenarios.test.tsx"], { cwd: resolve(root, "apps/mac/ui"), capture: true });
  const matrixJson = parseScenarioMatrixStdout(matrixOut);
  if (matrixJson !== null) {
    writeFileSync(resolve(options.outDir, "scenario-matrix.json"), `${matrixJson}\n`, "utf8");
  }

  const allProblems: string[] = [];
  for (const scenario of options.scenarios) {
    const fakeDir = resolve(fakeRoot, scenario);
    const homeDir = resolve(options.outDir, "runtime", scenario, "home");
    const workDir = resolve(options.outDir, "runtime", scenario, "work");
    const storeDb = resolve(options.outDir, "runtime", scenario, "state.db");
    const dumpPath = resolve(options.outDir, `${scenario}-dump.json`);
    const stepsPath = resolve(options.outDir, `${scenario}-steps.txt`);
    const appLogPath = resolve(options.outDir, `${scenario}-app.log`);

    mkdirSync(fakeDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(dirname(storeDb), { recursive: true });
    rmSync(dumpPath, { force: true });

    copyFileSync(resolve(root, `apps/mac/ui/fixtures/scenarios/${scenario}/state.json`), resolve(fakeDir, "state.json"));
    writeScenarioResponses(root, scenario, resolve(fakeDir, "responses.json"));

    const plan = buildStepPlan(scenario, shotsDir);
    writeFileSync(stepsPath, `${plan.steps.join("\n")}\n`, "utf8");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VIBEVALLEY_HOME: homeDir,
      VIBEVALLEY_WORK_ROOT: workDir,
      VIBEVALLEY_STORE: storeDb,
      VIBEVALLEY_NO_OPENING: "1",
      VIBEVALLEY_NO_ANIMATION: "1",
      VIBEVALLEY_FAKE_SERVER: fakeDir,
      VIBEVALLEY_DEBUG_DUMP: dumpPath,
      VIBEVALLEY_DEBUG_SCRIPT: stepsPath,
    };

    const run = spawnSync(macBin, [], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    writeFileSync(appLogPath, `${run.stdout ?? ""}\n${run.stderr ?? ""}`, "utf8");
    if (run.status !== 0) {
      allProblems.push(`${scenario}: vibevalley-mac exited with ${String(run.status)} (see ${appLogPath})`);
      continue;
    }
    if (!existsSync(dumpPath)) {
      allProblems.push(`${scenario}: missing dump file ${dumpPath} (see ${appLogPath})`);
      continue;
    }
    const rawDump: unknown = JSON.parse(readFileSync(dumpPath, "utf8"));
    allProblems.push(...validateDumpAndShots(scenario, rawDump, plan.expectedShots));
  }

  runChecked("vpx", ["scripts/audit/ui-report.ts", "--dir", options.outDir], { cwd: root });

  if (allProblems.length > 0) {
    throw new Error(`ui-gallery failed:\n- ${allProblems.join("\n- ")}`);
  }
  console.log(`ui-gallery: verified ${options.scenarios.join(", ")} -> ${resolve(options.outDir, "index.html")}`);
}

if (import.meta.main) {
  runGallery();
}
