import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { parseAllDocuments } from "yaml";

import { scanStyleDependencies } from "./style-migration-dependencies";
import { hash, migrationInputs, migrationOutput, migrationRoot } from "./style-migration-inputs";
import { ownedSemanticClasses, reviewedStyleKeys } from "./style-migration-ownership";
import { migrationProgress } from "./style-migration-progress";
import { inlineStyleReviews } from "./style-migration-reviews";
import { scanStyleCss, scanStyleHtml, scanStyleSource, type StyleFinding } from "./style-migration-scan";

const record = (input: unknown): Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {};
const scriptExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]);
const expectedGraphs = [
  { name: "app-client", entry: "apps/web/src/main.tsx", output: "apps/web/dist" },
  { name: "stories-client", entry: "apps/web/src/stories.tsx", output: "apps/web/dist-stories" },
  { name: "site-client", entry: "apps/site/src/App.tsx", output: "apps/site/dist/client" },
  { name: "site-ssr", entry: "apps/site/src/Document.tsx", output: "apps/site/dist/server" },
];
const requiredRoots = ["apps/web/src", "apps/site/src", "packages/stories/src", "packages/base-ui/src"];
const findings: StyleFinding[] = [];
const coverage: { path: string; hash: string | null; parser: string; parsed: boolean; expressions: number }[] = [];
const classifications: { path: string; offset: number; kind: string }[] = [];
const graphs: { path: string; modules: number; artifacts: number; complete: boolean }[] = [];
const add = (category: string, path: string, evidence: string) => findings.push({ category, path, offset: 0, evidence });
const inputs = migrationInputs();
const maintained = new Set(inputs.files.filter((file) => file.hash !== null).map((file) => file.path));

for (const path of requiredRoots)
  if (!existsSync(resolve(migrationRoot, path))) add("missing-source-root", path, "Fix: restore the required source root; an empty scan is not acceptance.");
for (const path of globSync("{apps,packages}/*/src/**/*", { cwd: migrationRoot })) {
  if (statSync(resolve(migrationRoot, path)).isFile() && !maintained.has(path))
    add("unlisted-source-file", path, "Filesystem discovery found a source file absent from the independent Git inventory.");
}

for (const file of inputs.files) {
  if (file.hash === null) {
    coverage.push({ ...file, parser: "deleted-tracked-input", parsed: true, expressions: 0 });
    continue;
  }
  const extension = extname(file.path);
  const absolute = resolve(migrationRoot, file.path);
  if (scriptExtensions.has(extension)) {
    const reviews = reviewedStyleKeys(inlineStyleReviews.filter((review) => review.path === file.path));
    const scan = scanStyleSource(file.path, readFileSync(absolute, "utf8"), ownedSemanticClasses(file.path), reviews);
    coverage.push({ ...file, parser: "oxc", parsed: scan.parsed, expressions: scan.expressions });
    findings.push(...scan.findings);
    classifications.push(...scan.classifications.map((classification) => ({ ...classification, path: file.path })));
  } else if (extension === ".css") {
    const found = scanStyleCss(file.path, readFileSync(absolute, "utf8"));
    coverage.push({ ...file, parser: "lightningcss", parsed: !found.some((finding) => finding.category === "css-parse-error"), expressions: 0 });
    findings.push(...found);
  } else if (extension === ".html") {
    const scan = scanStyleHtml(file.path, readFileSync(absolute, "utf8"), ownedSemanticClasses(file.path));
    coverage.push({ ...file, parser: "parse5", parsed: scan.parsed, expressions: scan.expressions });
    findings.push(...scan.findings);
    classifications.push(...scan.classifications.map((classification) => ({ ...classification, path: file.path })));
  } else if ([".astro", ".mdx", ".vue", ".svelte"].includes(extension)) {
    coverage.push({ ...file, parser: "unsupported-style-container", parsed: false, expressions: 0 });
    add(
      extension === ".astro" ? "website-astro-source" : "unparsed-style-container",
      file.path,
      "Fix: migrate or add syntax-aware coverage; do not skip this file.",
    );
  } else if (file.path.endsWith("package.json") || file.path === "pnpm-workspace.yaml" || file.path === "pnpm-lock.yaml") {
    try {
      const text = readFileSync(absolute, "utf8");
      const documents = extension === ".json" ? undefined : parseAllDocuments(text);
      if (documents?.length === 0 || documents?.some((document) => document.errors.length > 0) === true)
        throw new Error(`Invalid dependency documents: ${file.path}`);
      const data: unknown = documents === undefined ? JSON.parse(text) : documents.map((document) => document.toJS());
      const dependencies = scanStyleDependencies(file.path, data);
      findings.push(...dependencies.findings);
      classifications.push(...dependencies.classifications);
      if (file.path === "apps/site/package.json")
        for (const key of ["dependencies", "devDependencies"]) {
          for (const name of Object.keys(record(record(data)[key])))
            if (/^(?:react(?:$|-)|@types\/react(?:$|-))/u.test(name)) add("website-react-dependency", file.path, name);
        }
      coverage.push({ ...file, parser: "dependency-manifest", parsed: true, expressions: 0 });
    } catch (error) {
      coverage.push({ ...file, parser: "dependency-manifest", parsed: false, expressions: 0 });
      add("manifest-parse-error", file.path, String(error));
    }
  } else coverage.push({ ...file, parser: "non-source-input", parsed: true, expressions: 0 });
}

for (const expected of expectedGraphs) {
  const name = expected.name;
  const path = `.test/style-migration/graphs/${name}.json`;
  try {
    const graph = record(JSON.parse(readFileSync(resolve(migrationRoot, path), "utf8")));
    const modules: unknown[] = Array.isArray(graph.modules) ? graph.modules : [];
    const artifacts: unknown[] = Array.isArray(graph.artifacts) ? graph.artifacts : [];
    const complete =
      graph.schemaVersion === 1 &&
      graph.complete === true &&
      modules.length > 0 &&
      artifacts.length > 0 &&
      `${String(graph.entry)}-${String(graph.environment)}` === name &&
      graph.outputDirectory === expected.output;
    if (
      !modules.some((value) => {
        const id = record(value).id;
        return typeof id === "string" && id.split("?")[0]?.endsWith(`/${expected.entry}`) === true;
      })
    )
      add("missing-build-entry", path, expected.entry);
    graphs.push({ path, modules: modules.length, artifacts: artifacts.length, complete });
    if (!complete) add("incomplete-build-graph", path, "Fix: run the full production build, including prerendering.");
    if (record(graph.inputs).digest !== inputs.digest || record(graph.inputs).lockfileHash !== inputs.lockfileHash)
      add("stale-build-inputs", path, "Fix: rebuild after the last source or dependency change.");
    const ids = new Set(modules.map((module) => record(module).id));
    for (const value of modules) {
      const module = record(value);
      if (
        typeof module.id !== "string" ||
        !Array.isArray(module.imports) ||
        !Array.isArray(module.dynamicImports) ||
        typeof module.renderedBytes !== "number"
      ) {
        add("invalid-module-graph-node", path, JSON.stringify(value));
        continue;
      }
      if (module.renderedBytes > 0 && module.codeHash === null && module.id !== "rolldown:runtime") add("missing-module-source", path, module.id);
      if (name.endsWith("client"))
        for (const dependency of [...module.imports, ...module.dynamicImports]) {
          if (!ids.has(dependency)) add("missing-module-graph-edge", path, `${module.id} -> ${String(dependency)}`);
        }
      if (module.renderedBytes > 0 && /(?:^|\/)node_modules\/(?:@tailwindcss\/|tailwindcss\/)/u.test(module.id))
        add("shipped-tailwind-module", path, module.id);
      if (name === "site-client" && module.renderedBytes > 0 && /(?:^|\/)node_modules\/(?:react(?:-dom)?\/|astro\/|@astrojs\/)/u.test(module.id))
        add("shipped-website-framework", path, module.id);
    }
    const declaredArtifacts = new Set<string>();
    for (const value of artifacts) {
      const artifact = record(value);
      if (typeof artifact.path !== "string" || typeof artifact.hash !== "string") {
        add("invalid-artifact-record", path, JSON.stringify(value));
        continue;
      }
      if (!artifact.path.startsWith(`${expected.output}/`)) {
        add("artifact-outside-build-output", artifact.path, path);
        continue;
      }
      declaredArtifacts.add(artifact.path);
      const absolute = resolve(migrationRoot, artifact.path);
      if (!existsSync(absolute)) {
        add("missing-build-artifact", artifact.path, path);
        continue;
      }
      const bytes = readFileSync(absolute);
      if (hash(bytes) !== artifact.hash) add("stale-build-artifact", artifact.path, path);
      if (extname(absolute) === ".css") findings.push(...scanStyleCss(artifact.path, bytes.toString("utf8")));
      if (/\.(?:html|js)$/u.test(absolute)) {
        const content = bytes.toString("utf8");
        if (/--tw-[a-z]/u.test(content)) add("tailwind-output-composition", artifact.path, "--tw-* in production output");
        if (name === "site-client" && /<astro-(?:island|slot)\b/u.test(content))
          add("website-astro-output", artifact.path, "Astro runtime element in production output");
      }
    }
    if (typeof graph.outputDirectory !== "string") add("missing-output-directory", path, "Build provenance must identify its output directory.");
    else
      for (const entry of readdirSync(resolve(migrationRoot, graph.outputDirectory), { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          const artifact = relative(migrationRoot, resolve(entry.parentPath, entry.name));
          if (!declaredArtifacts.has(artifact)) add("unlisted-build-artifact", artifact, path);
        }
      }
  } catch (error) {
    add("missing-or-invalid-build-graph", path, String(error));
  }
}

for (const review of inlineStyleReviews) if (!maintained.has(review.path)) add("stale-inline-review", review.path, review.reason);

if (coverage.filter((file) => file.parser === "oxc").length === 0) add("empty-source-scan", "", "No parsed source files");
if (migrationInputs().digest !== inputs.digest) add("source-changed-during-inventory", "", "Fix: rerun against stable inputs.");
const counts: Record<string, number> = {};
for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  status: findings.length === 0 ? "passed" : "failed",
  inputs,
  expectedGraphs,
  graphs,
  coverage,
  classifications,
  counts,
  progress: migrationProgress(findings),
  findings,
};
await mkdir(migrationOutput, { recursive: true });
await writeFile(resolve(migrationOutput, "inventory.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      status: report.status,
      files: coverage.length,
      graphs: graphs.length,
      counts,
      progress: report.progress,
      report: relative(migrationRoot, resolve(migrationOutput, "inventory.json")),
    },
    null,
    2,
  ),
);
if (report.status !== "passed") process.exitCode = 1;
