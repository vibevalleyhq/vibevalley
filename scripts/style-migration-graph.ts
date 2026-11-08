import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { Plugin } from "vite-plus";

import { hash, migrationInputs, migrationOutput, migrationRoot, type MigrationInputs } from "#migration-inputs";

export function styleMigrationGraph(entry: "app" | "stories" | "site"): Plugin {
  let inputs: MigrationInputs | undefined;
  return {
    name: `style-migration-graph-${entry}`,
    apply: "build",
    enforce: "post",
    buildStart() {
      inputs = migrationInputs();
    },
    writeBundle: {
      order: "post",
      sequential: true,
      async handler(options, bundle) {
        if (!inputs || !options.dir) throw new Error("Missing migration build inputs or output directory");
        if (migrationInputs().digest !== inputs.digest) throw new Error("Source changed during the production build. Fix: rebuild from stable inputs.");
        const rendered = new Map<string, number>();
        for (const output of Object.values(bundle))
          if (output.type === "chunk") {
            for (const [id, module] of Object.entries(output.modules)) rendered.set(id, (rendered.get(id) ?? 0) + module.renderedLength);
          }
        const modules = [...this.getModuleIds()].toSorted().map((id) => {
          const info = this.getModuleInfo(id);
          if (!info) throw new Error(`Missing module graph node: ${id}`);
          return {
            id,
            entry: info.isEntry,
            imports: info.importedIds,
            dynamicImports: info.dynamicallyImportedIds,
            renderedBytes: rendered.get(id) ?? 0,
            codeHash: info.code === null ? null : hash(info.code),
          };
        });
        if (modules.length === 0 || rendered.size === 0) throw new Error("Empty production module graph");
        const artifacts = outputArtifacts(options.dir);
        const environment = this.environment.name;
        const report = {
          schemaVersion: 1,
          entry,
          environment,
          createdAt: new Date().toISOString(),
          inputs,
          modules,
          artifacts,
          outputDirectory: relative(migrationRoot, resolve(options.dir)),
          complete: entry !== "site" || environment !== "client",
        };
        const expected =
          entry === "site"
            ? resolve(migrationRoot, "apps/site/dist", environment === "ssr" ? "server" : "client")
            : resolve(migrationRoot, "apps/web", entry === "app" ? "dist" : "dist-stories");
        const canonical = resolve(options.dir) === expected;
        const directory = resolve(migrationOutput, canonical ? "graphs" : "graphs/fixtures");
        const name = `${entry}-${environment}${canonical ? "" : `-${hash(options.dir).slice(0, 12)}`}.json`;
        await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, name), JSON.stringify(report, null, 2) + "\n");
      },
    },
  };
}

function outputArtifacts(directory: string) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = resolve(entry.parentPath, entry.name);
      return { path: relative(migrationRoot, file), hash: hash(readFileSync(file)) };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function sealSiteMigrationGraph(directory: string) {
  const path = resolve(migrationOutput, "graphs/site-client.json");
  const report: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof report !== "object" ||
    report === null ||
    !("inputs" in report) ||
    typeof report.inputs !== "object" ||
    report.inputs === null ||
    !("digest" in report.inputs)
  )
    throw new Error("Missing site build provenance");
  if (migrationInputs().digest !== report.inputs.digest) throw new Error("Source changed during prerendering. Fix: rebuild from stable inputs.");
  await writeFile(path, JSON.stringify({ ...report, complete: true, artifacts: outputArtifacts(directory) }, null, 2) + "\n");
}
