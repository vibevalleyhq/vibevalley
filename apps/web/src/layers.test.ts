// The features' graph has no cycle; their order among the page's other layers, and that a feature is used through its
// index.ts, are the lint's (scripts/oxlint-plugin.ts, page-layers). A feature that needs one needing it back has a piece
// in the wrong place, most often words or a helper the two share (apps/web/README.md).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { expect, test } from "vite-plus/test";

const features = join(import.meta.dirname, "features");

function graph() {
  const edges = new Map<string, Set<string>>();
  for (const feature of readdirSync(features)) {
    const uses = new Set<string>();
    for (const file of readdirSync(join(features, feature), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file)) continue;
      const at = join(features, feature, file);
      for (const m of readFileSync(at, "utf8").matchAll(/(?:from|import)\s*"(\.[^"]+)"/g)) {
        const path = relative(features, join(dirname(at), m[1]!));
        const used = path.split(sep)[0]!;
        if (!path.startsWith("..") && used !== feature) uses.add(used);
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
      if (found.length) return found;
    }
    path.pop();
    done.add(f);
    return [];
  };
  for (const f of edges.keys()) {
    const found = visit(f);
    if (found.length) return found;
  }
  return [];
}

test("the features' imports have no cycle", () => {
  expect(cycleIn(graph())).toEqual([]);
});

test("a cycle is found and named", () => {
  const edges = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a"])],
  ]);
  expect(cycleIn(edges)).toEqual(["a", "b", "c", "a"]);
});
