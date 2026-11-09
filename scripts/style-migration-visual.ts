/* oxlint-disable no-await-in-loop -- Pixel evidence is decoded serially to bound memory across the canonical catalogue. */
import { readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  buildEvidence,
  evidenceFailures,
  fileEvidence,
  inputFailures,
  list,
  originalRevision,
  readJson,
  receiptFailures,
  record,
  reportTimeFailures,
  setFailures,
  type FileEvidence,
} from "./style-migration-evidence";
import { migrationInputs, migrationOutput, migrationRoot, sourceInputs } from "./style-migration-inputs";
import { comparePixels } from "./style-migration-pixels";
import { liveScenarios, staticScenes } from "./style-migration-scenes";

export function visualScenarioFailures(value: unknown, live: boolean): string[] {
  const scenario = record(value);
  const visual = record(scenario.visual);
  const failures: string[] = [];
  const images = [visual.before, visual.repeat, visual.after].map(record);
  if (images.some((image) => typeof image.path !== "string" || typeof image.hash !== "string")) failures.push("missing capture evidence");
  if (new Set(images.map((image) => image.path)).size !== 3) failures.push("A/A and candidate must be separate captures");
  if (live) {
    const fixture = record(scenario.fixture);
    const snapshots = [fixture.snapshot, fixture.before, fixture.repeat, fixture.after].map(record);
    if (snapshots.some((snapshot) => typeof snapshot.path !== "string" || typeof snapshot.hash !== "string"))
      failures.push("missing real-server restoration evidence");
    if (new Set(snapshots.map((snapshot) => snapshot.hash)).size !== 1) failures.push("real-server fixture changed between captures");
    if (new Set(snapshots.map((snapshot) => snapshot.path)).size !== 4) failures.push("fixture must be measured independently after each restoration");
  } else if (scenario.textEqual !== true) failures.push("static text changed or was not compared");
  return failures;
}

export async function deriveVisual(baselinePath: string) {
  await rm(resolve(migrationOutput, "visual.json"), { force: true });
  const baselineRoot = resolve(baselinePath);
  if (baselineRoot === migrationRoot) throw new Error("The candidate cannot be its own visual baseline");
  const baseline = sourceInputs(baselineRoot);
  if (baseline.revision !== originalRevision)
    throw new Error(`Fix: restore approved original baseline ${originalRevision}; rewritten baselines are not accepted.`);
  const inputs = migrationInputs();
  const builds = buildEvidence();
  const errors: string[] = [];
  const receipts: FileEvidence[] = [];
  const expected = [...staticScenes.map((scene) => scene.id), ...liveScenarios];
  const executed: { id: string; status: "passed" | "failed"; errors: string[]; evidence: unknown; stability?: unknown; comparison?: unknown }[] = [];
  await mkdir(resolve(migrationOutput, "diff"), { recursive: true });
  for (const [kind, filename, scenarios] of [
    ["static", "visual-static.json", staticScenes.map((scene) => scene.id)],
    ["live", "live.json", liveScenarios],
  ] as const) {
    try {
      const path = resolve(migrationOutput, filename);
      const receipt = record(readJson(path));
      receipts.push(fileEvidence(path));
      errors.push(...receiptFailures(receipt, kind, scenarios, inputs, builds, baseline).map((error) => `${filename}: ${error}`));
      errors.push(
        ...reportTimeFailures(
          receipt.createdAt,
          builds.map((build) => record(readJson(build.path)).createdAt),
        ),
      );
      if (kind === "static") {
        const outputs = list(receipt.outputs).map(record);
        if (outputs.length !== 6) errors.push("Static report lacks the six original/candidate build outputs");
        for (const output of outputs) {
          if (typeof output.root !== "string") {
            errors.push("Missing static output root");
            continue;
          }
          const root = output.root;
          const artifacts = list(output.artifacts).map(record);
          const files = readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((file) => file.isFile())
            .map((file) => resolve(file.parentPath, file.name));
          if (files.length === 0) errors.push(`Empty static output ${root}`);
          errors.push(
            ...setFailures(
              artifacts.map((artifact) => (typeof artifact.path === "string" ? resolve(root, artifact.path) : artifact.path)),
              files,
              "static output artifacts",
            ),
          );
          for (const artifact of artifacts)
            errors.push(...evidenceFailures({ ...artifact, path: typeof artifact.path === "string" ? resolve(root, artifact.path) : undefined }));
        }
        for (const fixture of list(receipt.fixtures)) errors.push(...evidenceFailures(fixture));
      }
      for (const id of scenarios) {
        const scenario = record(list(receipt.executed).find((value) => record(value).id === id));
        const failures = visualScenarioFailures(scenario, kind === "live");
        const visual = record(scenario.visual);
        const fixture = record(scenario.fixture);
        for (const evidence of [...list(scenario.evidence), ...Object.values(visual), ...(kind === "live" ? Object.values(fixture) : [])])
          failures.push(...evidenceFailures(evidence));
        const result: (typeof executed)[number] = { id, status: "failed", errors: failures, evidence: scenario };
        if (failures.length === 0) {
          try {
            const before = String(record(visual.before).path);
            const repeat = String(record(visual.repeat).path);
            const after = String(record(visual.after).path);
            const stability = await comparePixels(
              resolve(migrationRoot, before),
              resolve(migrationRoot, repeat),
              resolve(migrationOutput, "diff", `${id}-unstable.png`),
            );
            result.stability = stability;
            if (!stability.passed) failures.push("baseline A/A is unstable");
            else {
              const comparison = await comparePixels(
                resolve(migrationRoot, before),
                resolve(migrationRoot, after),
                resolve(migrationOutput, "diff", `${id}-diff.png`),
              );
              result.comparison = comparison;
              if (!comparison.passed) failures.push("candidate differs from original (zero-pixel tolerance)");
            }
          } catch (error) {
            failures.push(String(error));
          }
        }
        result.status = failures.length === 0 && scenario.status === "passed" ? "passed" : "failed";
        executed.push(result);
      }
    } catch (error) {
      errors.push(`${filename}: ${String(error)}`);
    }
  }
  errors.push(...inputFailures(migrationInputs(), inputs), ...inputFailures(sourceInputs(baselineRoot), baseline));
  for (const build of builds) errors.push(...evidenceFailures(build));
  for (const receipt of receipts) errors.push(...evidenceFailures(receipt));
  errors.push(
    ...setFailures(
      executed.map((scenario) => scenario.id),
      expected,
      "visual scenarios",
    ),
  );
  const report = {
    schemaVersion: 1,
    kind: "visual",
    scope: "complete-canonical-visual",
    createdAt: new Date().toISOString(),
    inputs,
    baseline,
    builds,
    receipts,
    expected,
    executed,
    skipped: [],
    errors,
    status: errors.length === 0 && executed.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
    notCovered: ["behavior", "desktop-host", "mobile-host"],
  };
  await writeFile(resolve(migrationOutput, "visual.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (import.meta.main) {
  const args = parseArgs({ options: { baseline: { type: "string" } } });
  if (args.values.baseline === undefined)
    throw new Error(
      "Usage: vpx scripts/style-migration-visual.ts --baseline <original-worktree>; consumes visual-static.json and live.json, never static-only acceptance",
    );
  const report = await deriveVisual(args.values.baseline);
  console.info(
    `Canonical visual evidence: ${report.status}; ${report.executed.length}/${report.expected.length} scenarios. Full acceptance also requires migration:verify.`,
  );
  if (report.status !== "passed") process.exitCode = 1;
}
