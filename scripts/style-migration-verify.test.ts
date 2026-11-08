import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

import {
  evidenceFailures,
  fileEvidence,
  graphPaths,
  playwrightFailures,
  receiptFailures,
  recordedCommandFailures,
  reportTimeFailures,
  type FileEvidence,
  type MigrationReceipt,
} from "./style-migration-evidence";
import { cleanupFailures, hostCommandFailures } from "./style-migration-host-evidence";
import type { MigrationInputs } from "./style-migration-inputs";
import { behaviorScenarios, hostScenarios, liveScenarios, staticScenes } from "./style-migration-scenes";
import { commandFailures, inventoryFailures } from "./style-migration-verify";
import { visualScenarioFailures } from "./style-migration-visual";

const inputs: MigrationInputs = {
  revision: "original",
  digest: "dirty-source",
  lockfileHash: "lock",
  files: [{ path: "source.ts", hash: "source" }],
  tools: { node: "node-version", stylex: "compiler-version" },
};
const builds = graphPaths.map((path) => ({ path, hash: "a".repeat(64) }));
const ref = (path: string): FileEvidence => ({ path, hash: "b".repeat(64) });
const receipt = (): MigrationReceipt => ({
  schemaVersion: 1,
  kind: "host",
  createdAt: new Date().toISOString(),
  status: "passed",
  inputs,
  builds,
  expected: hostScenarios,
  executed: hostScenarios.map((id) => ({ id, status: "passed", evidence: [ref(`${id}.png`)] })),
  skipped: [],
  errors: [],
});

test("receipts cannot shrink canonical required scenarios or replace them with duplicate successes", () => {
  const shrunk = receipt();
  shrunk.expected = ["desktop-host"];
  shrunk.executed = shrunk.executed.slice(0, 1);
  expect(receiptFailures(shrunk, "host", hostScenarios, inputs, builds).join("\n")).toContain("mobile-host");
  const duplicate = receipt();
  duplicate.executed = [duplicate.executed[0]!, duplicate.executed[0]!];
  expect(receiptFailures(duplicate, "host", hostScenarios, inputs, builds).join("\n")).toContain("duplicates");
  expect(receiptFailures(receipt(), "host", hostScenarios, inputs, builds)).toEqual([]);
});

test.each(["skipped", "errors"] as const)("declared pass does not hide %s", (field) => {
  const report = receipt();
  report[field] = ["unavailable"];
  expect(receiptFailures(report, "host", hostScenarios, inputs, builds)).not.toEqual([]);
});

test.each(["revision", "digest", "lockfileHash"] as const)("stale %s invalidates a passing report", (key) => {
  const report = receipt();
  report.inputs = { ...inputs, [key]: "older" };
  expect(receiptFailures(report, "host", hostScenarios, inputs, builds).join("\n")).toContain(key);
});

test("compiler/tool changes and rebuilt graph provenance invalidate old receipts", () => {
  const report = receipt();
  report.inputs = { ...inputs, tools: { ...inputs.tools, stylex: "older" } };
  report.builds = builds.map((build) => ({ ...build, hash: "c".repeat(64) }));
  const errors = receiptFailures(report, "host", hostScenarios, inputs, builds).join("\n");
  expect(errors).toContain("tool versions");
  expect(errors).toContain("stale build");
});

test("failed scenarios, missing evidence, malformed receipts and future dates never pass", () => {
  const report = receipt();
  report.executed[0] = { id: "desktop-host", status: "failed", evidence: [] };
  report.createdAt = "2999-01-01T00:00:00.000Z";
  expect(receiptFailures(report, "host", hostScenarios, inputs, builds).length).toBeGreaterThanOrEqual(3);
  for (const absent of [undefined, null, [], {}, { status: "passed" }]) expect(receiptFailures(absent, "host", hostScenarios, inputs, builds)).not.toEqual([]);
});

test("changed or removed evidence invalidates the reference instead of trusting the report status", () => {
  const directory = mkdtempSync(join(tmpdir(), "migration-evidence-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "observed.json");
  writeFileSync(path, "observed real result");
  const evidence = fileEvidence(path);
  expect(evidenceFailures(evidence)).toEqual([]);
  writeFileSync(path, "different result");
  expect(evidenceFailures(evidence)[0]).toContain("changed evidence");
  rmSync(path);
  expect(evidenceFailures(evidence)[0]).toContain("missing evidence");
});

test("a process that failed, was signalled, or never launched cannot be rescued by passing receipts", () => {
  for (const command of [
    { command: ["verify"], code: 1, signal: null },
    { command: ["verify"], code: null, signal: "SIGTERM" },
    { command: ["verify"], code: null, signal: null, error: "ENOENT" },
    { command: ["verify"], code: 0, signal: null, error: "spawn failed" },
  ])
    expect(commandFailures([command])).toHaveLength(1);
  expect(commandFailures([{ command: ["verify"], code: 0, signal: null }])).toEqual([]);
});

function browserReport(status = "passed", expectedStatus = "passed", outcome = "expected", attempts = 1) {
  return {
    errors: [],
    suites: [
      {
        title: "pages.spec.ts",
        specs: [
          {
            title: "keyboard behavior",
            tests: [{ projectName: "desktop", status: outcome, expectedStatus, results: Array.from({ length: attempts }, () => ({ status })) }],
          },
        ],
      },
    ],
  };
}

test("browser receipts require exactly the discovered tests, not an empty or filtered success", () => {
  const discovery = browserReport();
  expect(playwrightFailures(discovery, browserReport())).toEqual([]);
  expect(playwrightFailures(discovery, { errors: [], suites: [] }).join("\n")).toContain("missing");
  expect(playwrightFailures({ errors: [], suites: [] }, { errors: [], suites: [] })).toContain("empty browser discovery");
});

test.each([
  ["skipped", "passed", "skipped", 1],
  ["failed", "failed", "expected", 1],
  ["passed", "passed", "flaky", 2],
  ["passed", "passed", "expected", 0],
] as const)("skips, expected failures and retries are not acceptance: %s/%s/%s/%s", (status, expectedStatus, outcome, attempts) => {
  expect(playwrightFailures(browserReport(), browserReport(status, expectedStatus, outcome, attempts))).not.toEqual([]);
});

test("visual proof requires distinct A/A/candidate captures and independently restored identical real fixtures", () => {
  const scenario = {
    visual: { before: ref("before.png"), repeat: ref("repeat.png"), after: ref("after.png") },
    fixture: { snapshot: ref("snapshot.json"), before: ref("before.json"), repeat: ref("repeat.json"), after: ref("after.json") },
  };
  expect(visualScenarioFailures(scenario, true)).toEqual([]);
  expect(visualScenarioFailures({ ...scenario, visual: { ...scenario.visual, repeat: scenario.visual.before } }, true).join("\n")).toContain(
    "separate captures",
  );
  expect(
    visualScenarioFailures({ ...scenario, fixture: { ...scenario.fixture, after: { ...scenario.fixture.after, hash: "different" } } }, true).join("\n"),
  ).toContain("fixture changed");
  expect(visualScenarioFailures({ visual: scenario.visual }, true).join("\n")).toContain("restoration evidence");
  expect(visualScenarioFailures({ ...scenario, textEqual: false }, false).join("\n")).toContain("static text");
});

test("canonical coverage includes every area/theme/width and cannot collapse to static-only evidence", () => {
  expect(liveScenarios).toHaveLength(60);
  expect(new Set(liveScenarios).size).toBe(liveScenarios.length);
  expect(liveScenarios).toContain("farm-overlays-dark-390");
  expect(liveScenarios).toContain("tree-overlays-light-1440");
  for (const hour of ["morning", "day", "evening", "night"])
    for (const motion of ["reduce", "no-preference"]) expect(staticScenes.some((scene) => scene.hour === hour && scene.reducedMotion === motion)).toBe(true);
  expect(behaviorScenarios).toContain("web-integration");
  expect(receiptFailures({ ...receipt(), kind: "static" }, "host", hostScenarios, inputs, builds).join("\n")).toContain("kind");
});

test("inventory must be freshly produced with complete nonempty coverage and all build graphs", () => {
  const now = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    status: "passed",
    inputs,
    findings: [],
    counts: {},
    coverage: [{ parsed: true }],
    graphs: graphPaths.map((path) => ({ path, complete: true, modules: 1, artifacts: 1 })),
    createdAt: now,
  };
  expect(inventoryFailures(report, inputs, now)).toEqual([]);
  expect(inventoryFailures({ ...report, createdAt: "2000-01-01T00:00:00.000Z" }, inputs, now).join("\n")).toContain("this verification run");
  for (const invalid of [
    { ...report, coverage: [] },
    { ...report, coverage: [{ parsed: false }] },
    { ...report, graphs: [] },
    { ...report, findings: ["unconverted"] },
  ])
    expect(inventoryFailures(invalid, inputs, now)).not.toEqual([]);
});

test("host process and cleanup receipts fail on missing observations and leaks", () => {
  expect(hostCommandFailures({ code: 0, timedOut: false, stopped: true, unexpectedDescendants: false })).toEqual([]);
  expect(hostCommandFailures({ code: 0 })).not.toEqual([]);
  expect(hostCommandFailures({ code: 0, timedOut: false, stopped: true, unexpectedDescendants: true })).not.toEqual([]);
  expect(cleanupFailures({ code: 0, stopped: true, cleanupErrors: [] }, "sandbox")).toEqual([]);
  expect(cleanupFailures({ code: 0, stopped: false, cleanupErrors: [] }, "sandbox")).not.toEqual([]);
  expect(cleanupFailures({ stopped: true, gracefulShutdown: false }, "emulator")).not.toEqual([]);
  expect(cleanupFailures({ stopped: true, removed: false, errors: [] }, "host")).not.toEqual([]);
});

test("a receipt cannot claim evidence from a build produced after its execution", () => {
  expect(reportTimeFailures("2026-11-09T12:00:00.000Z", ["2026-11-09T11:00:00.000Z"])).toEqual([]);
  expect(reportTimeFailures("2026-11-09T11:00:00.000Z", ["2026-11-09T12:00:00.000Z"])).toContain("receipt predates its production build");
  expect(reportTimeFailures("invalid", [])).not.toEqual([]);
});

test("nested subprocess accounting cannot be omitted or laundered by passed test JSON", () => {
  expect(recordedCommandFailures(undefined)).not.toEqual([]);
  expect(recordedCommandFailures([])).not.toEqual([]);
  expect(recordedCommandFailures([{ command: ["playwright", "test"], code: 1, signal: null }])).not.toEqual([]);
  expect(recordedCommandFailures([{ command: ["playwright", "test"], code: 0, signal: null }])).toEqual([]);
});
