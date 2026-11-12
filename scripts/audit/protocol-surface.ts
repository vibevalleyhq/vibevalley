import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");
const ratchetPath = resolve(root, "scripts/audit/protocol-surface.ratchet.json");

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

const RatchetSchema = z.object({
  publicShapes: z.number(),
  publicSchemas: z.number(),
  totalProtocolExports: z.number(),
  serverOnlyShapes: z.number(),
});
const ratchetKeys = ["publicShapes", "publicSchemas", "totalProtocolExports", "serverOnlyShapes"] as const satisfies readonly (keyof Ratchet)[];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps", "packages", "scripts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "" && existsSync(resolve(root, f)) && /\.(?:ts|tsx)$/u.test(f));
}

function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/.*$/gmu, " ")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu, " ");
}

function barrelSymbols(barrelText: string): string[] {
  const out: string[] = [];
  for (const match of barrelText.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"[^"]+";/gmu)) {
    for (const raw of match[1]!.split(",")) {
      const cleaned = raw
        .trim()
        .replace(/^type\s+/u, "")
        .trim();
      if (cleaned !== "") out.push(cleaned);
    }
  }
  return out;
}

function collectBarrelReferences(raw: string, clean: string, specifierPattern: string): Set<string> {
  const out = new Set<string>();
  const nsNames: string[] = [];
  const stmtRe = new RegExp(`(?:import|export)\\s+(?:type\\s+)?(\\*\\s+as\\s+([A-Za-z0-9_$]+)|\\{([^}]+)\\})\\s+from\\s+["'](?:${specifierPattern})["']`, "gu");
  for (const m of raw.matchAll(stmtRe)) {
    if (m[2] !== undefined) nsNames.push(m[2]);
    if (m[3] !== undefined) {
      for (const part of m[3].split(",")) {
        const orig = part
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0]!
          .trim();
        if (orig !== "") out.add(orig);
      }
    }
  }
  for (const ns of nsNames) {
    const nsRe = new RegExp(`\\b${ns}\\.([A-Za-z_][A-Za-z0-9_]*)\\b`, "gu");
    for (const m of clean.matchAll(nsRe)) out.add(m[1]!);
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

  const usedShapes = new Set<string>();
  const usedShapesInServer = new Set<string>();
  const usedShapesOutsideServer = new Set<string>();
  const usedSchemas = new Set<string>(["Wire"]);

  const shapeSpec = "@vibevalley/protocol(?:/shapes)?|\\.\\.?/(?:shapes|index)(?:\\.ts)?";
  const schemaSpec = "@vibevalley/protocol/schema|\\.\\.?/schema(?:\\.ts)?";

  for (const file of barrelConsumers) {
    const raw = readFileSync(resolve(root, file), "utf8");
    const clean = stripCommentsAndStrings(raw);
    const isServer = file.startsWith("apps/server/");
    const isCrossClientOrContract =
      file === "packages/protocol/src/client.ts" ||
      file.startsWith("packages/protocol/src/") ||
      file.startsWith("apps/web/") ||
      file.startsWith("apps/cli/") ||
      file.startsWith("apps/desktop/") ||
      file.startsWith("apps/mobile/") ||
      (file.startsWith("packages/") && !file.startsWith("packages/protocol/"));

    for (const sym of collectBarrelReferences(raw, clean, shapeSpec)) {
      usedShapes.add(sym);
      if (isServer) usedShapesInServer.add(sym);
      if (isCrossClientOrContract) usedShapesOutsideServer.add(sym);
    }
    // schema.test.ts iterates Object.entries(S) over whatever schema.ts exports, so it does not justify keeping an unused codec.
    if (file !== "packages/protocol/src/schema.test.ts") {
      for (const sym of collectBarrelReferences(raw, clean, schemaSpec)) {
        usedSchemas.add(sym);
      }
    }
  }

  const leakedShapes = publicShapeNames.filter((name) => !usedShapes.has(name));
  const leakedSchemas = publicSchemaNames.filter((name) => name !== "Wire" && !usedSchemas.has(name));
  const serverOnlyShapeNames = publicShapeNames.filter((name) => usedShapesInServer.has(name) && !usedShapesOutsideServer.has(name));

  const protocolSourceFiles = files.filter((f) => f.startsWith("packages/protocol/src/") && !f.endsWith(".test.ts") && f !== "packages/protocol/src/client.ts");
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
    problems.push(`missing ${ratchetPath}; run \`vpx scripts/audit/protocol-surface.ts --write\``);
  } else {
    const kept = RatchetSchema.parse(JSON.parse(readFileSync(ratchetPath, "utf8")));
    for (const key of ratchetKeys) {
      if (metrics[key] > kept[key]) {
        problems.push(
          `protocol surface ${key} grew from ${kept[key]} to ${metrics[key]}. Fix: keep helper shapes internal to packages/protocol/src/<concept>/ or server-private shapes inside apps/server/src/.`,
        );
      } else if (metrics[key] < kept[key] && !write) {
        problems.push(
          `protocol surface ${key} shrank from ${kept[key]} to ${metrics[key]}. Fix: run \`vpx scripts/audit/protocol-surface.ts --write\` to lock in the smaller baseline.`,
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
