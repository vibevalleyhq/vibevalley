import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export const ratchetPath = "scripts/audit/effect.ratchet.json";

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

/** Files that import Effect: the repository is leaving it (.agents/notes/proposed/architecture/2026-11-11-plain-typescript-without-effect.md), so this only goes down. */
export function effectFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages", "scripts"], { encoding: "utf8" }).stdout;
  return listed
    .split("\n")
    .filter((f) => /\.(?:ts|tsx|mts)$/u.test(f) && !f.endsWith(".d.ts") && !f.includes("/node_modules/") && existsSync(f))
    .filter((f) => /from\s+["'](?:effect|@effect\/[\w-]+)(?:\/[\w./-]+)?["']|import\(["'](?:effect|@effect\/)/u.test(readFileSync(f, "utf8")));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { write: { type: "boolean" } } });
  const plugin = pluginOf(JSON.parse(readFileSync("tsconfig.base.json", "utf8")));
  // A rule the config does not name is off: only the rules it names hold (errors fail).
  const unnamed = allRules().filter((rule) => !(rule in plugin.diagnosticSeverity));
  const config = JSON.stringify({
    ...plugin,
    diagnosticSeverity: { ...plugin.diagnosticSeverity, ...Object.fromEntries(unnamed.map((r) => [r, "off"])) },
  });
  const found = await Promise.all(projects.map(async (project) => ({ project, diagnostics: await diagnose(project, config) })));

  const here = `${process.cwd()}/`;
  const where = (d: Diagnostic) => `${d.file.replace(here, "")}:${d.line}:${d.column} ${d.name}: ${d.message}`;
  const failed = new Set<string>();
  for (const { diagnostics } of found) for (const d of diagnostics) if (d.severity === "error" || d.severity === "warning") failed.add(where(d));

  const files = effectFiles().length;
  if (values.write === true) {
    writeFileSync(ratchetPath, JSON.stringify({ files }, null, 2) + "\n");
    console.log(`effect: ${files} files import Effect, written to the ratchet`);
  }
  const kept: unknown = JSON.parse(readFileSync(ratchetPath, "utf8"));
  const keptFiles = Predicate.hasProperty(kept, "files") && typeof kept.files === "number" ? kept.files : 0;
  const problems: string[] = [];
  if (files > keptFiles)
    problems.push(
      `${files} files import Effect (kept ${keptFiles}): new code does not use it. Fix: write it in plain TypeScript. See .agents/notes/proposed/architecture/2026-11-11-plain-typescript-without-effect.md`,
    );
  else if (files < keptFiles) problems.push(`${files} files import Effect, down from ${keptFiles}. Fix: \`vp run effect:write\` lowers the ratchet.`);
  for (const line of failed) console.error(line);
  for (const p of problems) console.error(`effect: ${p}`);
  if (failed.size > 0 || problems.length > 0) process.exit(1);
  console.log(`effect: ${projects.length} projects clean; ${files} files import Effect`);
}
