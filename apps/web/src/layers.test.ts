import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { expect, test } from "vite-plus/test";

import { edgesOf } from "@vibevalley/testkit/source";

const featureLayers: ReadonlyArray<{ readonly name: string; readonly features: readonly string[] }> = [
  {
    name: "Primitives",
    features: ["artifact", "catalog", "memory", "pkm", "provider", "runtime", "session", "terminal", "user", "voice"],
  },
  {
    name: "Domain",
    features: ["channel", "lan", "media", "orchestrator", "repo"],
  },
  {
    name: "Workbench",
    features: ["agent", "connector", "inbox", "issue"],
  },
  {
    name: "Settings",
    features: ["setting"],
  },
];

const featureRank = new Map(featureLayers.flatMap((layer, rank) => layer.features.map((feature) => [feature, rank] as const)));

const features = join(import.meta.dirname, "features");

function graph() {
  const edges = new Map<string, Set<string>>();
  for (const feature of readdirSync(features)) {
    const uses = new Set<string>();
    for (const file of readdirSync(join(features, feature), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/u.test(file)) continue;
      const at = join(features, feature, file);
      for (const { from } of edgesOf(at, readFileSync(at, "utf8"))) {
        // A feature is reached by a relative path or, from outside its folder, as #/features/<feature>.
        const path = from.startsWith("#/features/")
          ? from.slice("#/features/".length)
          : from.startsWith(".")
            ? relative(features, join(dirname(at), from))
            : undefined;
        const used = path?.split(/[/\\]/u)[0];
        if (path !== undefined && !path.startsWith("..") && used !== undefined && used !== feature) uses.add(used);
      }
    }
    edges.set(feature, uses);
  }
  return edges;
}

/** A cycle as the features along it, the first one again at the end; empty when there is none. */
function cycleIn(edges: Map<string, Set<string>>): string[] {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (f: string): string[] => {
    const at = path.indexOf(f);
    if (at >= 0) return [...path.slice(at), f];
    if (done.has(f)) return [];
    path.push(f);
    for (const g of edges.get(f) ?? []) {
      const found = visit(g);
      if (found.length > 0) return found;
    }
    path.pop();
    done.add(f);
    return [];
  };
  for (const f of edges.keys()) {
    const found = visit(f);
    if (found.length > 0) return found;
  }
  return [];
}

test("the features' imports have no cycle", () => {
  expect(
    cycleIn(graph()),
    "a feature needing one that needs it back has a piece in the wrong place, most often words or a helper the two share: move it below both (apps/web/README.md)",
  ).toEqual([]);
});

test("every feature folder belongs to a layer in featureLayers", () => {
  const listed = new Set(featureLayers.flatMap((layer) => layer.features));
  const actual = readdirSync(features);
  const missing = actual.filter((feature) => !listed.has(feature));
  const stale = [...listed].filter((feature) => !actual.includes(feature));
  expect(missing, "new feature folder under src/features/ is missing from featureLayers in apps/web/src/layers.test.ts").toEqual([]);
  expect(stale, "stale entry in featureLayers no longer exists under src/features/").toEqual([]);
});

test("features import only features in earlier layers", () => {
  const edges = graph();
  const leaks: string[] = [];
  for (const [feature, uses] of edges) {
    const rank = featureRank.get(feature);
    if (rank === undefined) continue;
    for (const used of uses) {
      const usedRank = featureRank.get(used);
      if (usedRank === undefined || usedRank >= rank) leaks.push(`${feature} -> ${used}`);
    }
  }
  expect(
    leaks,
    "a feature imports another feature from the same or a higher layer in featureLayers. Fix: move shared UI or helpers down to ui/domain or infra, or place the dependency in an earlier layer (apps/web/README.md)",
  ).toEqual([]);
});

test("feature models never import feature views", () => {
  const violations: string[] = [];
  for (const feature of readdirSync(features)) {
    const modelDir = join(features, feature, "model");
    if (!existsSync(modelDir)) continue;
    for (const file of readdirSync(modelDir, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/u.test(file)) continue;
      const at = join(modelDir, file);
      for (const { from } of edgesOf(at, readFileSync(at, "utf8"))) {
        if (/(?:^|\/)views(?:\/|$)/u.test(from)) violations.push(`${feature}/model/${file} -> ${from}`);
      }
    }
  }
  expect(
    violations,
    "a feature model imports a feature view component. Fix: move shared headless logic into features/<feature>/model/ so views depend on models, not the reverse",
  ).toEqual([]);
});

test("a cycle is found and named", () => {
  const edges = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a"])],
  ]);
  expect(cycleIn(edges)).toEqual(["a", "b", "c", "a"]);
});
