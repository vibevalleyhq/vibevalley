import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hash, migrationRoot, type MigrationInputs } from "./style-migration-inputs";

export const originalRevision = "a12ad2ee4f72775d8835a3e1f0c3f6e8a08c7c37";

export interface FileEvidence {
  path: string;
  hash: string;
}
export interface ScenarioReceipt {
  id: string;
  status: "passed" | "failed";
  evidence: FileEvidence[];
  visual?: { before: FileEvidence; repeat: FileEvidence; after: FileEvidence };
  fixture?: { snapshot: FileEvidence; before: FileEvidence; repeat: FileEvidence; after: FileEvidence };
  discovery?: FileEvidence;
  results?: FileEvidence;
  error?: string;
}
export interface MigrationReceipt {
  schemaVersion: 1;
  kind: "live" | "host" | "behavior" | "static";
  createdAt: string;
  status: "passed" | "failed";
  inputs: MigrationInputs;
  builds: FileEvidence[];
  baseline?: { revision: string; digest: string; lockfileHash: string };
  expected: readonly string[];
  executed: ScenarioReceipt[];
  skipped: string[];
  errors: string[];
}

export const graphPaths = ["app-client", "stories-client", "site-client", "site-ssr"].map((name) => `.test/style-migration/graphs/${name}.json`);
export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const fileEvidence = (path: string): FileEvidence => ({ path, hash: hash(readFileSync(resolve(migrationRoot, path))) });
export const buildEvidence = (): FileEvidence[] => graphPaths.map(fileEvidence);
export const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(migrationRoot, path), "utf8"));
const sameMap = (left: unknown, right: unknown) =>
  JSON.stringify(Object.entries(record(left)).toSorted(([a], [b]) => a.localeCompare(b))) ===
  JSON.stringify(Object.entries(record(right)).toSorted(([a], [b]) => a.localeCompare(b)));

export function inputFailures(
  value: unknown,
  expected: Pick<MigrationInputs, "revision" | "digest" | "lockfileHash"> & { tools?: Record<string, string> },
): string[] {
  const input = record(value);
  const failures = ["revision", "digest", "lockfileHash"].filter((key) => input[key] !== record(expected)[key]).map((key) => `stale or missing input ${key}`);
  if (expected.tools !== undefined && !sameMap(input.tools, expected.tools)) failures.push("tool versions differ");
  return failures;
}

export function setFailures(actual: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(actual)) return [`${label} is missing`];
  const failures: string[] = [];
  if (new Set(actual).size !== actual.length) failures.push(`${label} contains duplicates`);
  for (const id of expected) if (!actual.includes(id)) failures.push(`${label} missing ${id}`);
  for (const id of actual) if (typeof id !== "string" || !expected.includes(id)) failures.push(`${label} unexpected ${String(id)}`);
  return failures;
}

export function evidenceFailures(value: unknown): string[] {
  const evidence = record(value);
  if (typeof evidence.path !== "string" || typeof evidence.hash !== "string" || !/^[a-f0-9]{64}$/u.test(evidence.hash)) return ["invalid evidence reference"];
  try {
    return fileEvidence(evidence.path).hash === evidence.hash ? [] : [`changed evidence ${evidence.path}`];
  } catch (error) {
    return [`missing evidence ${evidence.path}: ${String(error)}`];
  }
}

export function receiptFailures(
  value: unknown,
  kind: MigrationReceipt["kind"],
  expected: readonly string[],
  inputs: MigrationInputs,
  builds: readonly FileEvidence[],
  baseline?: MigrationReceipt["baseline"],
): string[] {
  const receipt = record(value);
  const failures: string[] = [];
  if (receipt.schemaVersion !== 1 || receipt.kind !== kind) failures.push("invalid receipt schema or kind");
  if (receipt.status !== "passed") failures.push("receipt did not pass");
  const createdAt = typeof receipt.createdAt === "string" ? Date.parse(receipt.createdAt) : NaN;
  if (!Number.isFinite(createdAt) || createdAt > Date.now() + 5000) failures.push("invalid receipt timestamp");
  failures.push(...inputFailures(receipt.inputs, inputs));
  if (baseline !== undefined) failures.push(...inputFailures(receipt.baseline, baseline).map((failure) => `baseline ${failure}`));
  for (const key of ["errors", "skipped"]) if (!Array.isArray(receipt[key]) || receipt[key].length !== 0) failures.push(`${key} must be an empty array`);
  const recordedBuilds = list(receipt.builds).map(record);
  failures.push(
    ...setFailures(
      recordedBuilds.map((build) => build.path),
      builds.map((build) => build.path),
      "build provenance",
    ),
  );
  for (const build of builds)
    if (!recordedBuilds.some((item) => item.path === build.path && item.hash === build.hash)) failures.push(`stale build ${build.path}`);
  failures.push(...setFailures(receipt.expected, expected, "expected scenarios"));
  const executed = list(receipt.executed).map(record);
  failures.push(
    ...setFailures(
      executed.map((scenario) => scenario.id),
      expected,
      "executed scenarios",
    ),
  );
  for (const scenario of executed) {
    if (scenario.status !== "passed") failures.push(`scenario did not pass: ${String(scenario.id)}`);
    if (!Array.isArray(scenario.evidence) || scenario.evidence.length === 0) failures.push(`scenario lacks evidence: ${String(scenario.id)}`);
  }
  return failures;
}

export function reportTimeFailures(createdAt: unknown, buildTimes: unknown[]): string[] {
  const timestamp = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const times = buildTimes.map((value) => (typeof value === "string" ? Date.parse(value) : NaN));
  if (!Number.isFinite(timestamp) || times.length === 0 || times.some((time) => !Number.isFinite(time))) return ["missing report/build timestamps"];
  return times.some((time) => timestamp < time) ? ["receipt predates its production build"] : [];
}

export function recordedCommandFailures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["missing subprocess accounting"];
  return value.flatMap((item) => {
    const command = record(item);
    return command.code === 0 && command.signal === null && command.error === undefined && list(command.command).length > 0
      ? []
      : ["recorded subprocess failed, was signalled, or never ran"];
  });
}

interface BrowserCase {
  id: string;
  status: unknown;
  expectedStatus: unknown;
  results: unknown[];
}
export function playwrightCases(value: unknown): BrowserCase[] {
  const visit = (suite: unknown, ancestors: string[]): BrowserCase[] => {
    const node = record(suite);
    const path = [...ancestors, ...(typeof node.title === "string" ? [node.title] : [])];
    return [
      ...list(node.specs).flatMap((value) => {
        const spec = record(value);
        return list(spec.tests).map((value) => {
          const test = record(value);
          return {
            id: JSON.stringify([test.projectName, ...path, spec.title]),
            status: test.status,
            expectedStatus: test.expectedStatus,
            results: list(test.results),
          };
        });
      }),
      ...list(node.suites).flatMap((child) => visit(child, path)),
    ];
  };
  return list(record(value).suites).flatMap((suite) => visit(suite, []));
}

export function playwrightFailures(discovery: unknown, result: unknown): string[] {
  const expected = playwrightCases(discovery).map((test) => test.id);
  const executed = playwrightCases(result);
  const failures = setFailures(
    executed.map((test) => test.id),
    expected,
    "browser tests",
  );
  if (expected.length === 0) failures.push("empty browser discovery");
  for (const report of [discovery, result]) {
    if (!Array.isArray(record(report).errors) || list(record(report).errors).length !== 0) failures.push("browser report has errors or lacks error accounting");
  }
  for (const test of executed) {
    if (test.status !== "expected" || test.expectedStatus !== "passed" || test.results.length !== 1 || record(test.results[0]).status !== "passed")
      failures.push(`browser test not executed exactly once successfully: ${test.id}`);
  }
  return failures;
}
