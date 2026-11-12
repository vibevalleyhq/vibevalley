import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

const packages = join(import.meta.dirname, "../..", "packages");
const Manifest = z.object({
  exports: z.exactOptional(z.record(z.string(), z.union([z.string(), z.object({ types: z.exactOptional(z.string()), default: z.exactOptional(z.string()) })]))),
});

const wrong: string[] = [];
for (const name of readdirSync(packages)) {
  const manifest = join(packages, name, "package.json");
  if (!existsSync(manifest) || !existsSync(join(packages, name, "vite.config.ts"))) continue;
  if (!readFileSync(join(packages, name, "vite.config.ts"), "utf8").includes("pack:")) continue;
  const { exports } = Manifest.parse(JSON.parse(readFileSync(manifest, "utf8")));
  for (const [path, target] of Object.entries(exports ?? {})) {
    if (path.endsWith(".css") && typeof target === "string") {
      if (!target.startsWith("./src/") || !target.endsWith(".css") || !existsSync(join(packages, name, target))) {
        wrong.push(`packages/${name}: "${path}" must point to an existing ./src/… stylesheet`);
      }
      continue;
    }
    if (typeof target === "string" || target.types === undefined || target.default === undefined) {
      wrong.push(`packages/${name}: "${path}" is not { types: ./dist/….d.ts, default: ./src/… }`);
      continue;
    }
    // A pattern export (./*) is checked by its folder: its types are there once anything is built.
    const types = target.types.includes("*") ? dirname(target.types) : target.types;
    if (!existsSync(join(packages, name, types))) wrong.push(`packages/${name}: "${path}" says its types are ${target.types}, which the build did not write`);
  }
}
if (wrong.length > 0) {
  console.error(
    `${wrong.join("\n")}\nFix: point each export's types at what its pack block writes (dist/<the source's path under src>.d.ts; fixedExtension: false keeps it .d.ts), and run vp run packages:build. See docs/subsystems/foundation.md`,
  );
  process.exit(1);
}
