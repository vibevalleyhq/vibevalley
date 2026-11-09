import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { inputFailures, list, playwrightFailures, readJson, record } from "./style-migration-evidence";
import { migrationRoot, type MigrationInputs } from "./style-migration-inputs";

export function hostCommandFailures(value: unknown): string[] {
  const command = record(value);
  if (command.code !== 0 || command.timedOut !== false || command.stopped !== true || command.unexpectedDescendants !== false || command.error !== undefined)
    return ["native command failed, did not run, timed out, or leaked a process"];
  return [];
}

export function cleanupFailures(value: unknown, kind: "sandbox" | "emulator" | "host"): string[] {
  const cleanup = record(value);
  if (cleanup.stopped !== true) return ["native cleanup did not stop owned processes"];
  if (kind === "sandbox" && (cleanup.code !== 0 || !Array.isArray(cleanup.cleanupErrors) || cleanup.cleanupErrors.length !== 0))
    return ["sandbox failed or cleanup failed"];
  if (kind === "emulator" && cleanup.gracefulShutdown !== true) return ["emulator did not shut down gracefully"];
  if (kind === "host" && (cleanup.removed !== true || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0))
    return ["host sandbox was not removed cleanly"];
  return [];
}

export function hostEvidenceFailures(value: unknown, inputs: MigrationInputs): string[] {
  const receipt = record(value);
  const evidence = list(receipt.executed)
    .flatMap((scenario) => list(record(scenario).evidence))
    .map(record);
  const paths = evidence.flatMap((ref) => (typeof ref.path === "string" ? [resolve(migrationRoot, ref.path)] : []));
  const failures: string[] = [];
  const required = (suffix: string) => {
    const matches = [...new Set(paths.filter((path) => path.endsWith(`/host/${suffix}`)))];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous native evidence: host/${suffix}`);
    return matches[0]!;
  };
  try {
    failures.push(...cleanupFailures(readJson(required("cleanup.json")), "host"));
    failures.push(...playwrightFailures(readJson(required("desktop/discovery.json")), readJson(required("desktop/playwright.json"))));
    for (const name of ["desktop.png", "desktop-farm.png", "opening-failure.png"])
      if (!paths.some((path) => path.includes("/host/desktop/screens/") && path.endsWith(`/${name}`))) failures.push(`Missing desktop capture: ${name}`);
    failures.push(...cleanupFailures(readJson(required("mobile/sandbox/result.json")), "sandbox"));
    failures.push(...cleanupFailures(readJson(required("mobile/cleanup.json")), "emulator"));
    if (record(readJson(required("mobile/server-cleanup.json"))).stopped !== true) failures.push("The mobile sandbox server process was not observed stopped");
    const application = record(readJson(required("mobile/application-process.json")));
    if (application.code !== 1 || application.stdout !== "" || application.error !== undefined)
      failures.push("The native application process survived cleanup or could not be inspected");
    required("mobile/android-farm.png");
    const mobileLog = readFileSync(required("mobile/sandbox/command.stdout.log"), "utf8");
    for (const marker of [
      "paired and seen",
      "bridge: the page's notice shown by the phone",
      "bridge: the reloaded page owns a fresh host",
      "back after a restart",
    ])
      if (!mobileLog.includes(marker)) failures.push(`Missing native observation: ${marker}`);
    if (/bridge:\s*not checked/u.test(mobileLog)) failures.push("Native bridge was not checked");
    for (const host of ["desktop", "mobile"]) {
      const nativeBuild = record(readJson(required(`${host}/native-build.json`)));
      failures.push(...inputFailures(nativeBuild.inputs, inputs));
      const artifacts = list(nativeBuild.artifacts).map(record);
      if (artifacts.length === 0) failures.push(`${host}: native artifacts were not recorded`);
      for (const artifact of artifacts)
        if (!evidence.some((ref) => ref.path === artifact.path && ref.hash === artifact.hash))
          failures.push(`${host}: native artifact lacks a bound evidence reference`);
    }
    const commands = [...new Set(paths.filter((path) => path.endsWith("/result.json") && !path.endsWith("/mobile/sandbox/result.json")))];
    if (commands.length === 0) failures.push("No native subprocess receipts");
    for (const path of commands) failures.push(...hostCommandFailures(readJson(path)).map((failure) => `${path}: ${failure}`));
  } catch (error) {
    failures.push(String(error));
  }
  return failures;
}
