/**
 * The Effect rules oxlint runs in `vp check` (effect-tsgo patches them into oxlint in package.json's prepare): the
 * recommended preset, with tsconfig.base.json's diagnosticSeverity on top. That table is the one place the repository
 * tunes them, so `vp check` and `vp run effect:check` (the language service reading the same table) report the same
 * things; a rule that differs from the preset is written there, not here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

type Severity = "off" | "warn" | "error";

const read = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

/** The language service's severities in oxlint's words; a suggestion is not reported by either. */
function severity(value: unknown): Severity | undefined {
  if (value === "off" || value === "warn" || value === "error") return value;
  if (value === "warning") return "warn";
  if (value === "suggestion" || value === "message") return "off";
  return undefined;
}

/** anyUnknownInErrorContext is oxlint's any-unknown-in-error-context; a run of capitals is one word (cryptoRandomUUIDInEffect is crypto-random-uuid-in-effect). */
const ruleOf = (diagnostic: string) =>
  `effecttsgo/${diagnostic
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .toLowerCase()}`;

export function effectRules(): Record<string, Severity> {
  const rules: Record<string, Severity> = {};
  for (const [rule, value] of Object.entries(record(record(read("node_modules/@effect/tsgo/oxlint-presets/recommended.json")).rules))) {
    const s = severity(value);
    if (s !== undefined) rules[rule] = s;
  }
  const plugins = record(record(read("tsconfig.base.json")).compilerOptions).plugins;
  const service = Array.isArray(plugins) ? plugins.map(record).find((p) => p.name === "@effect/language-service") : undefined;
  for (const [diagnostic, value] of Object.entries(record(service?.diagnosticSeverity))) {
    const s = severity(value);
    if (s !== undefined) rules[ruleOf(diagnostic)] = s;
  }
  return rules;
}
