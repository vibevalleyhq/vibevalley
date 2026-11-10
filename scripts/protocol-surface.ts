import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ratchetPath = resolve(root, "scripts/protocol-surface.ratchet.json");

interface Ratchet {
  /** Named symbols re-exported from packages/protocol/src/shapes.ts. */
  readonly publicShapes: number;
  /** Named symbols re-exported from packages/protocol/src/schema.ts. */
  readonly publicSchemas: number;
  /** Total exported declarations across packages/protocol/src (excluding generated client.ts and tests). */
  readonly totalProtocolExports: number;
  /** Public shapes referenced only in apps/server (not in client.ts, api.ts, web, cli, desktop, mobile, or packages). */
  readonly serverOnlyShapes: number;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages", "scripts", "docs"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "" && existsSync(resolve(root, f)) && /\.(?:ts|tsx|md)$/u.test(f));
}

function barrelSymbols(barrelText: string): string[] {
  const out: string[] = [];
  for (const match of barrelText.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"[^"]+";/gmu)) {
    for (const raw of match[1]!.split(",")) {
      const cleaned = raw.trim().replace(/^type\s+/u, "").trim();
      if (cleaned !== "") out.push(cleaned);
    }
  }
  return out;
}

export function auditProtocolSurface() {
  const files = trackedFiles();
  const shapesText = readFileSync(resolve(root, "packages/protocol/src/shapes.ts"), "utf8");
  const schemaText = readFileSync(resolve(root, "packages/protocol/src/schema.ts"), "utf8");

  const wildcardProblems: string[] = [];
  if (/^export\s+\*\s+from\s+/mu.test(shapesText)) {
    wildcardProblems.push("packages/protocol/src/shapes.ts uses `export *`: list public contract shapes explicitly so helper types stay internal");
  }
  if (/^export\s+\*\s+from\s+/mu.test(schemaText)) {
    wildcardProblems.push("packages/protocol/src/schema.ts uses `export *`: list public schemas explicitly so helper codecs stay internal");
  }

  const publicShapeNames = barrelSymbols(shapesText);
  const publicSchemaNames = barrelSymbols(schemaText);

  const barrelConsumers = files.filter((f) => {
    if (!f.startsWith("packages/protocol/src/")) return true;
    if (f === "packages/protocol/src/shapes.ts" || f === "packages/protocol/src/schema.ts" || f === "packages/protocol/src/index.ts") return false;
    if (/^packages\/protocol\/src\/[^/]+\/(?:(?:audio-|common-)?schema|(?:audio-)?shapes)\.ts$/u.test(f)) return false;
    return true;
  });

  const usedByConsumers = new Set<string>();
  const usedOutsideServer = new Set<string>();
  const usedInServer = new Set<string>();

  for (const file of barrelConsumers) {
    const text = readFileSync(resolve(root, file), "utf8");
    const isServer = file.startsWith("apps/server/");
    const isCrossClientOrContract =
      file === "packages/protocol/src/client.ts" ||
      file.startsWith("packages/protocol/src/") ||
      file.startsWith("apps/web/") ||
      file.startsWith("apps/cli/") ||
      file.startsWith("apps/desktop/") ||
      file.startsWith("apps/mobile/") ||
      (file.startsWith("packages/") && !file.startsWith("packages/protocol/"));
    for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/gu)) {
      const word = m[0];
      usedByConsumers.add(word);
      if (isServer) usedInServer.add(word);
      if (isCrossClientOrContract) usedOutsideServer.add(word);
    }
  }

  const leakedShapes = publicShapeNames.filter((name) => !usedByConsumers.has(name));
  const leakedSchemas = publicSchemaNames.filter((name) => name !== "Wire" && !usedByConsumers.has(name));
  const serverOnlyShapeNames = publicShapeNames.filter((name) => usedInServer.has(name) && !usedOutsideServer.has(name));

  const protocolSourceFiles = files.filter(
    (f) => f.startsWith("packages/protocol/src/") && !f.endsWith(".test.ts") && f !== "packages/protocol/src/client.ts",
  );
  let totalProtocolExports = 0;
  for (const file of protocolSourceFiles) {
    const text = readFileSync(resolve(root, file), "utf8");
    totalProtocolExports += [...text.matchAll(/^export\s+(?:const|let|function|class|type|interface)\s+[A-Za-z_]/gmu)].length;
  }

  const metrics: Ratchet = {
    publicShapes: publicShapeNames.length,
    publicSchemas: publicSchemaNames.length,
    totalProtocolExports,
    serverOnlyShapes: serverOnlyShapeNames.length,
  };

  return { metrics, wildcardProblems, leakedShapes, leakedSchemas, serverOnlyShapeNames };
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const { metrics, wildcardProblems, leakedShapes, leakedSchemas } = auditProtocolSurface();
  const problems = [...wildcardProblems];

  if (leakedShapes.length > 0) {
    problems.push(
      `packages/protocol/src/shapes.ts exports ${leakedShapes.length} unreferenced symbol(s): ${leakedShapes.join(", ")}. Fix: remove them from src/shapes.ts (and drop \`export\` in the sub-module if unused there).`,
    );
  }
  if (leakedSchemas.length > 0) {
    problems.push(
      `packages/protocol/src/schema.ts exports ${leakedSchemas.length} unreferenced codec(s): ${leakedSchemas.join(", ")}. Fix: remove them from src/schema.ts (and drop \`export\` in the sub-module if unused there).`,
    );
  }

  if (write) {
    writeFileSync(ratchetPath, JSON.stringify(metrics, null, 2) + "\n");
  }

  if (!existsSync(ratchetPath)) {
    problems.push(`missing ${ratchetPath}; run \`node scripts/protocol-surface.ts --write\``);
  } else {
    const kept = JSON.parse(readFileSync(ratchetPath, "utf8")) as Ratchet;
    for (const key of Object.keys(kept) as (keyof Ratchet)[]) {
      if (metrics[key] > kept[key]) {
        problems.push(
          `protocol surface ${key} grew from ${kept[key]} to ${metrics[key]}. Fix: keep helper shapes internal to packages/protocol/src/<concept>/ or server-private shapes inside apps/server/src/.`,
        );
      } else if (metrics[key] < kept[key] && !write) {
        problems.push(
          `protocol surface ${key} shrank from ${kept[key]} to ${metrics[key]}. Fix: run \`node scripts/protocol-surface.ts --write\` to lock in the smaller baseline.`,
        );
      }
    }
  }

  for (const problem of problems) console.error(`protocol-surface: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `protocol-surface: ${metrics.publicShapes} shapes, ${metrics.publicSchemas} schemas, ${metrics.totalProtocolExports} decls, ${metrics.serverOnlyShapes} server-only ok`,
  );
}
