import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { Predicate } from "effect";

/** Every project Effect's language service checks; each has its own tsconfig.json. */
export const projects = [
  "apps/server",
  "apps/cli",
  "packages/agent",
  "packages/ai",
  "packages/provider",
  "packages/pkm",
  "packages/artifact",
  "packages/protocol",
  "packages/home",
  "packages/bridge",
  "packages/testkit",
  "packages/health",
  "apps/web",
  "apps/desktop",
] as const;

export const ratchetPath = "scripts/effect.ratchet.json";

/** Hits of each rule the config does not name yet, by project: they may only go down. */
export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

const see = "See .agents/skills/vv-effect/references/tools.md";

/** What is wrong with today's counts against the ratchet (empty when nothing). */
export function ratchetProblems(kept: Counts, now: Counts): string[] {
  const problems: string[] = [];
  for (const rule of [...new Set([...Object.keys(kept), ...Object.keys(now)])].toSorted()) {
    const before = kept[rule] ?? {};
    const after = now[rule] ?? {};
    for (const project of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
      const was = before[project] ?? 0;
      const is = after[project] ?? 0;
      if (is > was)
        problems.push(
          `${project} has ${is} ${rule} (kept ${was}): this change adds what the rule reports, and it may only go down. ` +
            `Fix: write it the way the rule's message says (the hits are listed above). ${see}`,
        );
      else if (is < was)
        problems.push(
          `${project} is down to ${is} ${rule} (kept ${was}). Fix: \`vp run effect:write\` lowers the ratchet, so the room is not spent by the next change. ${see}`,
        );
    }
  }
  for (const rule of Object.keys(kept).toSorted())
    if (Object.values(now[rule] ?? {}).every((n) => n === 0))
      problems.push(`${rule} has no hits left anywhere. Fix: set it to "error" in tsconfig.base.json's plugin and \`vp run effect:write\`. ${see}`);
  return problems;
}

type Diagnostic = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: string;
  readonly name: string;
  readonly message: string;
};

function allRules(): string[] {
  const require = createRequire(import.meta.url);
  // Compact, so the match does not depend on how the file is laid out.
  const schema = JSON.stringify(JSON.parse(readFileSync(join(dirname(require.resolve("@effect/tsgo/package.json")), "schema.json"), "utf8")));
  return [...new Set([...schema.matchAll(/"(\w+)":\{"\$ref":"#\/definitions\/effectLanguageServicePluginSeverity/gu)].map((m) => m[1]!))];
}

function pluginOf(tsconfig: unknown): Record<string, unknown> & { readonly diagnosticSeverity: Record<string, string> } {
  const plugins: unknown =
    Predicate.hasProperty(tsconfig, "compilerOptions") && Predicate.hasProperty(tsconfig.compilerOptions, "plugins") ? tsconfig.compilerOptions.plugins : [];
  const plugin: unknown = Array.isArray(plugins) ? plugins.find((p) => Predicate.hasProperty(p, "name") && p.name === "@effect/language-service") : undefined;
  if (!Predicate.isObject(plugin) || !Predicate.hasProperty(plugin, "diagnosticSeverity") || !Predicate.isObject(plugin.diagnosticSeverity))
    throw new Error("tsconfig.base.json has no @effect/language-service plugin with diagnosticSeverity");
  const severity: Record<string, string> = {};
  for (const [rule, level] of Object.entries(plugin.diagnosticSeverity)) if (typeof level === "string") severity[rule] = level;
  return { ...plugin, diagnosticSeverity: severity };
}

function diagnose(project: string, config: string): Promise<Diagnostic[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("effect-tsgo", ["diagnostics", "--project", `${project}/tsconfig.json`, "--format", "json", "--lspconfig", config], {
      stdio: ["ignore", "pipe", "inherit"],
      // vpx's shim sets NODE_PATH to Vite+'s own modules; through it effect-tsgo finds Vite+'s oxlint-tsgolint and fails
      // on its missing platform binary (this repository runs tsgolint on packages/tsrs).
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_PATH")),
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const parsed: unknown = JSON.parse(out);
        resolve(Predicate.hasProperty(parsed, "diagnostics") && Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []);
      } catch (e) {
        reject(new Error(`effect-tsgo gave no diagnostics for ${project}: ${String(e)}; it wrote: ${out.slice(0, 300)}`));
      }
    });
  });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { write: { type: "boolean" } } });
  const plugin = pluginOf(JSON.parse(readFileSync("tsconfig.base.json", "utf8")));
  const ratcheted = allRules().filter((rule) => !(rule in plugin.diagnosticSeverity));
  // The config's own levels, and each rule it does not name yet as a warning: errors fail, warnings are counted.
  const config = JSON.stringify({
    ...plugin,
    diagnosticSeverity: { ...plugin.diagnosticSeverity, ...Object.fromEntries(ratcheted.map((r) => [r, "warning"])) },
  });
  const found = await Promise.all(projects.map(async (project) => ({ project, diagnostics: await diagnose(project, config) })));

  const here = `${process.cwd()}/`;
  const where = (d: Diagnostic) => `${d.file.replace(here, "")}:${d.line}:${d.column} ${d.name}: ${d.message}`;
  const seen = new Set<string>();
  const failed: string[] = [];
  const now: Record<string, Record<string, number>> = Object.fromEntries(ratcheted.map((r) => [r, {}]));
  for (const { project, diagnostics } of found)
    for (const d of diagnostics) {
      // A file in two projects (a shared test helper) is reported by both: count it once.
      const key = `${d.file}:${d.line}:${d.column}:${d.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ratcheted.includes(d.name)) {
        const counts = (now[d.name] ??= {});
        counts[project] = (counts[project] ?? 0) + 1;
      } else if (d.severity === "error" || d.severity === "warning") failed.push(where(d));
    }

  if (values.write === true) {
    writeFileSync(ratchetPath, JSON.stringify(now, null, 2) + "\n");
    console.log(`effect: ratchet written for ${ratcheted.length} rules the config does not name yet`);
  }
  const kept: Counts = values.write === true ? now : JSON.parse(readFileSync(ratchetPath, "utf8"));
  const problems = ratchetProblems(kept, now);
  // The hits that broke the ratchet, in the files this change touches, so the message points at code.
  const grown = new Set(Object.keys(now).filter((rule) => Object.entries(now[rule] ?? {}).some(([project, n]) => n > (kept[rule]?.[project] ?? 0))));
  if (grown.size > 0) {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
    // At a commit, what is staged; otherwise everything that differs from HEAD.
    const staged = git("diff", "--cached", "--name-only");
    const changed = staged.length > 0 ? staged : [...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")];
    const touched = new Set(changed.map((f) => here + f));
    for (const { diagnostics } of found) for (const d of diagnostics) if (grown.has(d.name) && touched.has(d.file)) failed.push(where(d));
  }
  for (const line of [...new Set(failed)]) console.error(line);
  for (const p of problems) console.error(`effect: ${p}`);
  if (failed.length > 0 || problems.length > 0) process.exit(1);
  console.log(`effect: ${projects.length} projects clean; ${ratcheted.length} rules on the ratchet`);
}
