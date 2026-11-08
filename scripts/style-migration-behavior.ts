import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildEvidence,
  fileEvidence,
  inputFailures,
  playwrightCases,
  playwrightFailures,
  readJson,
  type FileEvidence,
  type MigrationReceipt,
  type ScenarioReceipt,
} from "./style-migration-evidence";
import { migrationInputs, migrationOutput, migrationRoot } from "./style-migration-inputs";
import { behaviorScenarios } from "./style-migration-scenes";

export interface CommandReceipt {
  command: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  code: number | null;
  signal: string | null;
  stdout: FileEvidence;
  stderr: FileEvidence;
  error?: string;
}

export function runCommand(id: string, command: string[], cwd = migrationRoot, environment: NodeJS.ProcessEnv = process.env): CommandReceipt {
  const directory = resolve(migrationOutput, "commands");
  mkdirSync(directory, { recursive: true });
  const stdout = resolve(directory, `${id}.stdout.log`);
  const stderr = resolve(directory, `${id}.stderr.log`);
  const out = openSync(stdout, "w");
  const err = openSync(stderr, "w");
  const startedAt = new Date().toISOString();
  try {
    const [executable, ...args] = command;
    if (executable === undefined) throw new Error("Missing subprocess command");
    const result = spawnSync(executable, args, { cwd, env: environment, stdio: ["ignore", out, err] });
    const receipt: CommandReceipt = {
      command,
      cwd,
      startedAt,
      finishedAt: new Date().toISOString(),
      code: result.status,
      signal: result.signal,
      stdout: fileEvidence(stdout),
      stderr: fileEvidence(stderr),
    };
    if (result.error !== undefined) receipt.error = String(result.error);
    return receipt;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

const suites = [
  {
    id: "site-production",
    cwd: "apps/site",
    config: "test/production/playwright.config.ts",
    required: [
      "production static HTML and initial CSS without JavaScript: /",
      "production static HTML and initial CSS without JavaScript: /en/",
      "production static HTML and initial CSS without JavaScript: /404.html",
      "regression: production hydration preserves top and offscreen DOM",
      "screenshot dialog traps focus, restores scrolling and survives interruption",
      "copy confirmation returns to idle and can be used again",
      "regression: selected hour controls retain hover styling and offscreen animations pause",
      "scroll narrative reaches every step after viewport resize",
      "language links perform full-document navigation",
    ],
  },
  {
    id: "site-prerender",
    cwd: "apps/site",
    config: "test/prerender/playwright.config.ts",
    required: [
      "regression: one hydration root preserves both visible and offscreen server DOM",
      "conditional children appear, dispose listeners, and remount fresh state",
      "language links load another pre-rendered document",
    ],
  },
  {
    id: "site-motion",
    cwd: ".",
    config: "scripts/style-migration-site.playwright.ts",
    required: [
      "production motion survives fast reverse scrolling and resize",
      "production offscreen animations pause and resume without overriding reduced motion",
      "production modal interruption releases DOM, scroll lock and focus before reopening",
    ],
  },
  {
    id: "web-components",
    cwd: "apps/web",
    config: "playwright.component.config.ts",
    required: [
      "regression: StyleX variables survive Base UI positioning and reactive variants",
      "regression: styled selects retain choices, disabled items and keyboard focus",
      "regression: styled tabs retain keyboard selection, navigation and dynamic list styles",
      "regression: text controls retain object styles, dynamic variables and input identity",
      "regression: button style variables compose with forwarded native attributes",
      "regression: pixel windows and fields preserve composed variables, editing and node identity",
    ],
  },
  { id: "web-integration", cwd: "apps/web", config: "playwright.integration.config.ts", required: [] },
] as const;

export function requiredBehaviorFailures(id: string, discovery: unknown): string[] {
  const suite = suites.find((suite) => suite.id === id);
  if (suite === undefined) return [`Unknown behavior suite ${id}`];
  const cases = playwrightCases(discovery);
  const failures: string[] = [];
  for (const title of suite.required)
    if (!cases.some((test) => test.id.endsWith(`${JSON.stringify(title)}]`))) failures.push(`Missing canonical behavior: ${title}`);
  if (id === "site-production")
    for (const project of ["desktop", "mobile-reduced"])
      if (!cases.some((test) => test.id.startsWith(`[${JSON.stringify(project)},`))) failures.push(`Missing website project ${project}`);
  if (id === "site-motion")
    for (const project of ["desktop-motion", "desktop-reduced", "mobile-motion", "mobile-reduced"])
      if (!cases.some((test) => test.id.startsWith(`[${JSON.stringify(project)},`))) failures.push(`Missing motion project ${project}`);
  if (id === "web-integration")
    for (const file of [
      "issues.spec.ts",
      "chat.spec.ts",
      "artifact.spec.ts",
      "agents.spec.ts",
      "farm.spec.ts",
      "tree.spec.ts",
      "settings.spec.ts",
      "narrow.spec.ts",
    ])
      if (!cases.some((test) => test.id.includes(file))) failures.push(`Missing integration coverage ${file}`);
  return failures;
}

export function runBehavior(): MigrationReceipt & { commands: CommandReceipt[]; scope: string } {
  rmSync(resolve(migrationOutput, "behavior.json"), { force: true });
  const inputs = migrationInputs();
  const builds = buildEvidence();
  const executed: ScenarioReceipt[] = [];
  const commands: CommandReceipt[] = [];
  const errors: string[] = [];
  const directory = resolve(migrationOutput, "behavior");
  mkdirSync(directory, { recursive: true });
  for (const suite of suites) {
    const scenario: ScenarioReceipt = { id: suite.id, status: "failed", evidence: [] };
    try {
      const cwd = resolve(migrationRoot, suite.cwd);
      const command = [resolve(cwd, "node_modules/.bin/playwright"), "test", "--config", suite.config, "--reporter=json", "--retries=0", "--workers=1"];
      const discovery = resolve(directory, `${suite.id}.discovery.json`);
      const results = resolve(directory, `${suite.id}.results.json`);
      rmSync(discovery, { force: true });
      rmSync(results, { force: true });
      const listed = runCommand(`${suite.id}-discovery`, [...command, "--list"], cwd, { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: discovery });
      commands.push(listed);
      scenario.evidence.push(listed.stdout, listed.stderr);
      if (listed.code !== 0 || listed.signal !== null || listed.error !== undefined) throw new Error(`Browser discovery failed: ${suite.id}`);
      scenario.discovery = fileEvidence(discovery);
      scenario.evidence.push(scenario.discovery);
      const discovered = readJson(discovery);
      const missing = requiredBehaviorFailures(suite.id, discovered);
      if (missing.length !== 0) throw new Error(missing.join("\n"));
      const run = runCommand(suite.id, command, cwd, { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: results });
      commands.push(run);
      scenario.evidence.push(run.stdout, run.stderr);
      if (run.code !== 0 || run.signal !== null || run.error !== undefined) throw new Error(`Browser suite failed: ${suite.id}`);
      scenario.results = fileEvidence(results);
      scenario.evidence.push(scenario.results);
      const failures = playwrightFailures(discovered, readJson(results));
      if (failures.length !== 0) throw new Error(failures.join("\n"));
      scenario.status = "passed";
    } catch (error) {
      scenario.error = String(error);
      errors.push(`${suite.id}: ${String(error)}`);
    }
    executed.push(scenario);
  }
  errors.push(...inputFailures(migrationInputs(), inputs));
  const report: MigrationReceipt & { commands: CommandReceipt[]; scope: string } = {
    schemaVersion: 1,
    kind: "behavior",
    createdAt: new Date().toISOString(),
    inputs,
    builds,
    expected: behaviorScenarios,
    executed,
    skipped: [],
    errors,
    commands,
    scope: "production-website-and-browser-behavior; component/integration fixtures are not live-server visual proof",
    status: errors.length === 0 && executed.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
  };
  writeFileSync(resolve(migrationOutput, "behavior.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (import.meta.main) {
  const report = runBehavior();
  console.info(`Behavior evidence: ${report.status}; ${report.executed.length}/${report.expected.length} suites`);
  if (report.status !== "passed") process.exitCode = 1;
}
