import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { captureVdpPngFile, ShellStateSchema, VdpWsClient, waitForVdpEndpoint } from "../release/vdp-client.ts";

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

export type GalleryStep =
  | { readonly kind: "rpc"; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "shot"; readonly path: string };

export interface GalleryStepPlan {
  readonly steps: readonly GalleryStep[];
  readonly expectedShots: readonly string[];
}

function shotStep(shotsDir: string, name: string, expected: string[]): GalleryStep {
  const file = resolve(shotsDir, `${name}.png`);
  expected.push(file);
  return { kind: "shot", path: file };
}

function routeStep(path: string): GalleryStep {
  return { kind: "rpc", method: "Shell.dispatchAction", params: { action: { type: "open_route", path } } };
}

export function buildStepPlan(scenario: GalleryScenario, shotsDir: string): GalleryStepPlan {
  const expected: string[] = [];
  const wait = (ms: number): GalleryStep => ({ kind: "wait", ms });
  const resize = (width: number, height: number): GalleryStep => ({ kind: "rpc", method: "Shell.resize", params: { width, height } });
  const toggleTheme: GalleryStep = { kind: "rpc", method: "Shell.setTheme", params: {} };
  const draw: GalleryStep = { kind: "rpc", method: "Page.draw", params: {} };
  const quit: GalleryStep = { kind: "rpc", method: "Shell.quit", params: {} };

  if (scenario === "typical") {
    const steps: GalleryStep[] = [
      resize(1280, 820),
      routeStep("/issues"),
      wait(900),
      draw,
      shotStep(shotsDir, "typical-issues-light", expected),
      toggleTheme,
      wait(400),
      draw,
      shotStep(shotsDir, "typical-issues-dark", expected),
      toggleTheme,
      resize(560, 820),
      wait(500),
      draw,
      shotStep(shotsDir, "typical-issues-narrow-light", expected),
      resize(1280, 820),
      routeStep("/chat"),
      wait(800),
      draw,
      shotStep(shotsDir, "typical-chat-light", expected),
      routeStep("/runs"),
      wait(700),
      draw,
      shotStep(shotsDir, "typical-runs-light", expected),
      routeStep("/agents"),
      wait(700),
      draw,
      shotStep(shotsDir, "typical-agents-light", expected),
      routeStep("/notes/art-launch-board"),
      wait(1100),
      draw,
      shotStep(shotsDir, "typical-whiteboard-light", expected),
      toggleTheme,
      wait(500),
      draw,
      shotStep(shotsDir, "typical-whiteboard-dark", expected),
      toggleTheme,
      routeStep("/settings/general"),
      wait(700),
      draw,
      shotStep(shotsDir, "typical-settings-light", expected),
      routeStep("/workspace"),
      wait(900),
      draw,
      shotStep(shotsDir, "typical-workspace-light", expected),
      toggleTheme,
      wait(400),
      draw,
      shotStep(shotsDir, "typical-workspace-dark", expected),
      toggleTheme,
      routeStep("/farm"),
      wait(900),
      draw,
      shotStep(shotsDir, "typical-farm", expected),
      routeStep("/issues"),
      wait(1200),
      quit,
    ];
    return { steps, expectedShots: expected };
  }

  const steps: GalleryStep[] = [
    resize(1280, 820),
    routeStep("/issues"),
    wait(900),
    draw,
    shotStep(shotsDir, "edge-issues-light", expected),
    toggleTheme,
    wait(400),
    draw,
    shotStep(shotsDir, "edge-issues-dark", expected),
    toggleTheme,
    routeStep("/library"),
    wait(800),
    draw,
    shotStep(shotsDir, "edge-library-light", expected),
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
  const list = parsed["note.list"];
  if (Array.isArray(list)) {
    const board: unknown = list.find((a) => typeof a === "object" && a !== null && "id" in a && a.id === "art-launch-board");
    if (board !== undefined) {
      parsed["note.get"] = board;
    }
  }
  writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function runGallery(): Promise<void> {
  const root = resolve(import.meta.dirname, "../..");
  const options = parseGalleryArgs(process.argv.slice(2));
  const shotsDir = resolve(options.outDir, "shots");
  const fakeRoot = resolve(options.outDir, "fake");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(fakeRoot, { recursive: true });

  const uiBundle = resolve(root, "apps/mac/ui/build/bundle.nshc");
  const uiShellBundle = resolve(root, "apps/mac/ui/build-shell/bundle.nshc");
  const nshBin = resolve(root, ".tools/bin/nsh");
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
  const macBin = resolve(targetDir, "debug/vibevalley-mac");

  if (!options.skipBuild || !existsSync(uiBundle) || !existsSync(uiShellBundle)) {
    runChecked(nshBin, ["build", "App.tsx", "-o", "build"], { cwd: resolve(root, "apps/mac/ui") });
    runChecked(nshBin, ["build", "ShellApp.tsx", "-o", "build-shell"], { cwd: resolve(root, "apps/mac/ui") });
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
    const appLogPath = resolve(options.outDir, `${scenario}-app.log`);

    mkdirSync(fakeDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(dirname(storeDb), { recursive: true });
    rmSync(dumpPath, { force: true });

    copyFileSync(resolve(root, `apps/mac/ui/fixtures/scenarios/${scenario}/state.json`), resolve(fakeDir, "state.json"));
    writeScenarioResponses(root, scenario, resolve(fakeDir, "responses.json"));

    const plan = buildStepPlan(scenario, shotsDir);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VIBEVALLEY_HOME: homeDir,
      VIBEVALLEY_WORK_ROOT: workDir,
      VIBEVALLEY_STORE: storeDb,
      VIBEVALLEY_NO_OPENING: "1",
      VIBEVALLEY_NO_ANIMATION: "1",
      VIBEVALLEY_FAKE_SERVER: fakeDir,
      VIBEVALLEY_DEBUG_PORT: "0",
    };

    const proc = spawn(macBin, [], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let appOutput = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      appOutput += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      appOutput += chunk.toString("utf8");
    });
    const exited = new Promise<number>((done) => {
      proc.once("exit", (code, sig) => done(code ?? (sig ? 1 : 0)));
      proc.once("error", () => done(1));
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 120_000);

    let rawDump: unknown = null;
    try {
      const endpoint = await waitForVdpEndpoint({
        homeDir,
        ...(proc.pid !== undefined ? { expectedPid: proc.pid } : {}),
        timeoutMs: 25_000,
        appExited: () => proc.exitCode,
      });
      const vdp = await VdpWsClient.connect(endpoint, 15_000);
      try {
        const loadDeadline = Date.now() + 20_000;
        while (Date.now() < loadDeadline) {
          const state = await vdp.callDecoded("Shell.getState", {}, ShellStateSchema);
          if (state.loaded) break;
          await sleep(100);
        }
        for (const step of plan.steps) {
          if (step.kind === "wait") {
            await sleep(step.ms);
          } else if (step.kind === "shot") {
            await captureVdpPngFile(vdp, step.path);
          } else if (step.method === "Shell.quit") {
            rawDump = await vdp.call("Shell.getState", {});
            writeFileSync(dumpPath, JSON.stringify(rawDump, null, 2), "utf8");
            await vdp.call(step.method, step.params);
          } else {
            await vdp.call(step.method, step.params);
          }
        }
      } finally {
        vdp.close();
      }
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) {
        await Promise.race([exited, sleep(5_000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    }

    const status = await exited;
    writeFileSync(appLogPath, appOutput, "utf8");
    if (status !== 0) {
      allProblems.push(`${scenario}: vibevalley-mac exited with ${String(status)} (see ${appLogPath})`);
      continue;
    }
    if (!existsSync(dumpPath) || rawDump === null) {
      allProblems.push(`${scenario}: missing dump file ${dumpPath} (see ${appLogPath})`);
      continue;
    }
    allProblems.push(...validateDumpAndShots(scenario, rawDump, plan.expectedShots));
  }

  runChecked("vpx", ["scripts/audit/ui-report.ts", "--dir", options.outDir], { cwd: root });

  if (allProblems.length > 0) {
    throw new Error(`ui-gallery failed:\n- ${allProblems.join("\n- ")}`);
  }
  console.log(`ui-gallery: verified ${options.scenarios.join(", ")} -> ${resolve(options.outDir, "index.html")}`);
}

if (import.meta.main) {
  await runGallery();
}
