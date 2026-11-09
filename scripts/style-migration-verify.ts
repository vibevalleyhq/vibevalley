import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { requiredBehaviorFailures, runCommand, type CommandReceipt } from "./style-migration-behavior";
import {
  buildEvidence,
  evidenceFailures,
  fileEvidence,
  graphPaths,
  inputFailures,
  list,
  playwrightFailures,
  readJson,
  receiptFailures,
  record,
  recordedCommandFailures,
  reportTimeFailures,
  setFailures,
  type FileEvidence,
} from "./style-migration-evidence";
import { hostEvidenceFailures } from "./style-migration-host-evidence";
import { migrationInputs, migrationOutput, migrationRoot, sourceInputs, type MigrationInputs } from "./style-migration-inputs";
import { behaviorScenarios, hostScenarios } from "./style-migration-scenes";
import { deriveVisual } from "./style-migration-visual";

export function commandFailures(commands: readonly Pick<CommandReceipt, "code" | "signal" | "error" | "command">[]): string[] {
  return commands.flatMap((command) =>
    command.code === 0 && command.signal === null && command.error === undefined
      ? []
      : [`Subprocess failed or did not run: ${command.command.join(" ")} (code ${command.code}, signal ${command.signal}, error ${command.error ?? "none"})`],
  );
}

export function inventoryFailures(value: unknown, inputs: MigrationInputs, startedAt: string): string[] {
  const inventory = record(value);
  const failures = inputFailures(inventory.inputs, inputs);
  if (inventory.schemaVersion !== 1 || inventory.status !== "passed") failures.push("Inventory did not pass");
  if (!Array.isArray(inventory.findings) || inventory.findings.length !== 0) failures.push("Inventory has findings or lacks findings accounting");
  if (Object.values(record(inventory.counts)).some((count) => count !== 0)) failures.push("Inventory finding counts are nonzero");
  if (!Array.isArray(inventory.coverage) || inventory.coverage.length === 0 || !inventory.coverage.every((item) => record(item).parsed === true))
    failures.push("Inventory source coverage is missing or incomplete");
  const graphs = list(inventory.graphs).map(record);
  failures.push(
    ...setFailures(
      graphs.map((graph) => graph.path),
      graphPaths,
      "inventory build graphs",
    ),
  );
  if (
    graphs.some(
      (graph) =>
        graph.complete !== true || typeof graph.modules !== "number" || graph.modules <= 0 || typeof graph.artifacts !== "number" || graph.artifacts <= 0,
    )
  )
    failures.push("Inventory build graph is incomplete");
  if (typeof inventory.createdAt !== "string" || !Number.isFinite(Date.parse(inventory.createdAt)) || Date.parse(inventory.createdAt) < Date.parse(startedAt))
    failures.push("Inventory was not produced by this verification run");
  return failures;
}

export async function verifyMigration(baselinePath: string, run: boolean) {
  mkdirSync(migrationOutput, { recursive: true });
  rmSync(resolve(migrationOutput, "acceptance.json"), { force: true });
  const commands: CommandReceipt[] = [];
  const errors: string[] = [];
  const evidence: FileEvidence[] = [];
  const inputs = migrationInputs();
  const baseline = sourceInputs(resolve(baselinePath));
  let builds: FileEvidence[] = [];
  if (resolve(baselinePath) === migrationRoot) errors.push("The candidate cannot be its own baseline");
  if (run && errors.length === 0) {
    for (const [id, command, receipt] of [
      ["capture-static", ["vpx", "scripts/style-migration-static.ts", "--baseline", resolve(baselinePath)], "visual-static.json"],
      ["capture-behavior", ["vpx", "scripts/style-migration-behavior.ts"], "behavior.json"],
      ["capture-live", ["vpx", "scripts/style-migration-live.ts", "--baseline", resolve(baselinePath)], "live.json"],
      ["capture-host", ["vpx", "scripts/style-migration-host.ts"], "host.json"],
    ] as const) {
      rmSync(resolve(migrationOutput, receipt), { force: true });
      commands.push(runCommand(id, [...command]));
    }
  }
  rmSync(resolve(migrationOutput, "inventory.json"), { force: true });
  const inventoryRun = runCommand("inventory", ["vpx", "scripts/style-migration.ts"]);
  commands.push(inventoryRun);
  errors.push(...commandFailures(commands));
  try {
    const inventoryPath = resolve(migrationOutput, "inventory.json");
    errors.push(...inventoryFailures(readJson(inventoryPath), inputs, inventoryRun.startedAt));
    evidence.push(fileEvidence(inventoryPath));
  } catch (error) {
    errors.push(`Inventory: ${String(error)}`);
  }
  try {
    builds = buildEvidence();
  } catch (error) {
    errors.push(`Build provenance: ${String(error)}`);
  }
  try {
    rmSync(resolve(migrationOutput, "visual.json"), { force: true });
    const visual = await deriveVisual(baselinePath);
    evidence.push(fileEvidence(resolve(migrationOutput, "visual.json")));
    if (visual.status !== "passed") errors.push("Canonical visual evidence did not pass; see visual.json");
  } catch (error) {
    errors.push(`Visual evidence: ${String(error)}`);
  }
  for (const [kind, scenarios] of [
    ["behavior", behaviorScenarios],
    ["host", hostScenarios],
  ] as const) {
    try {
      const path = resolve(migrationOutput, `${kind}.json`);
      const receipt = record(readJson(path));
      evidence.push(fileEvidence(path));
      errors.push(...receiptFailures(receipt, kind, scenarios, inputs, builds).map((error) => `${kind}: ${error}`));
      errors.push(
        ...reportTimeFailures(
          receipt.createdAt,
          builds.map((build) => record(readJson(build.path)).createdAt),
        ),
      );
      if (kind === "behavior") errors.push(...recordedCommandFailures(receipt.commands));
      for (const scenario of list(receipt.executed).map(record)) {
        const prefix = `${kind}/${String(scenario.id)}`;
        for (const item of list(scenario.evidence)) errors.push(...evidenceFailures(item).map((error) => `${prefix}: ${error}`));
        if (kind === "behavior") {
          for (const ref of [scenario.discovery, scenario.results]) errors.push(...evidenceFailures(ref).map((error) => `${prefix}: ${error}`));
          const discoveryPath = record(scenario.discovery).path;
          const resultsPath = record(scenario.results).path;
          if (typeof discoveryPath !== "string" || typeof resultsPath !== "string") errors.push(`${prefix}: missing browser discovery/results`);
          else {
            const discovery = readJson(discoveryPath);
            errors.push(...requiredBehaviorFailures(String(scenario.id), discovery), ...playwrightFailures(discovery, readJson(resultsPath)));
          }
        }
      }
      if (kind === "host") errors.push(...hostEvidenceFailures(receipt, inputs));
    } catch (error) {
      errors.push(`${kind}: ${String(error)}`);
    }
  }
  errors.push(...inputFailures(migrationInputs(), inputs), ...inputFailures(sourceInputs(resolve(baselinePath)), baseline));
  for (const ref of [...builds, ...evidence]) errors.push(...evidenceFailures(ref));
  const report = {
    schemaVersion: 1,
    kind: "acceptance",
    scope: "full-migration",
    createdAt: new Date().toISOString(),
    inputs,
    baseline,
    builds,
    evidence,
    commands,
    required: { inventory: "fresh-in-this-run", visual: "complete-canonical-visual", behavior: behaviorScenarios, host: hostScenarios },
    errors,
    status: errors.length === 0 ? "passed" : "failed",
  };
  writeFileSync(resolve(migrationOutput, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (import.meta.main) {
  const args = parseArgs({ options: { baseline: { type: "string" }, run: { type: "boolean", default: false } } });
  if (args.values.baseline === undefined)
    throw new Error(
      "Usage: vpx scripts/style-migration-verify.ts --baseline <original-worktree> [--run]. Build all canonical production outputs first. --run captures static/live/host and executes browser suites; without --run validates existing provenance-bound receipts and always runs fresh inventory.",
    );
  const report = await verifyMigration(args.values.baseline, args.values.run);
  console.info(`Migration acceptance: ${report.status}; ${report.errors.length} failures. Evidence: ${resolve(migrationOutput, "acceptance.json")}`);
  if (report.status !== "passed") process.exitCode = 1;
}
