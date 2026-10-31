import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { expect, test } from "vite-plus/test";

import { edgesOf } from "@vibevalley/testkit/source";

const features = join(import.meta.dirname, "features");

function graph() {
  const edges = new Map<string, Set<string>>();
  for (const feature of readdirSync(features)) {
    const uses = new Set<string>();
    for (const file of readdirSync(join(features, feature), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/u.test(file)) continue;
      const at = join(features, feature, file);
      for (const { from } of edgesOf(at, readFileSync(at, "utf8"))) {
        // A feature is reached by a relative path or, from outside its folder, as @/features/<feature>.
        const path = from.startsWith("@/features/")
          ? from.slice("@/features/".length)
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

test("a cycle is found and named", () => {
  const edges = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a"])],
  ]);
  expect(cycleIn(edges)).toEqual(["a", "b", "c", "a"]);
});
