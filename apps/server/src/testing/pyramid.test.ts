import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { pyramid } from "@vibevalley/testkit/pyramid";
import { importsOf } from "@vibevalley/testkit/source";

const root = join(import.meta.dirname, "../..");
const { reach } = pyramid(root);

function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(join(root, p)).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const all = files("src");
const resolve = (file: string, spec: string) =>
  normalize(relative(root, join(root, dirname(file), spec)))
    .split("\\")
    .join("/");

describe("the test pyramid", () => {
  it("builds the flows' whole farm only in src/flows", () => {
    const crossing = all.flatMap((f) =>
      f.startsWith("src/flows/")
        ? []
        : importsOf(f, readFileSync(join(root, f), "utf8"))
            .filter((s) => s.startsWith(".") && resolve(f, s).startsWith("src/flows/"))
            .map((s) => `${f} imports ${s}`),
    );
    expect(
      crossing,
      "the flows' whole farm is built only in src/flows: a module test that builds it is a flow test in the wrong place, slow and with too much in the way. Fix: test the module through its service with testing/world.ts's world, or move the test into src/flows. See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  // Into the workspace's packages too: packages/testkit's own tests hold that, with packages made for it.
  it("follows imports to the seam a file reaches", () => {
    expect(reach("src/modules/orchestrator/orchestrator.test.ts")).toEqual([
      "src/modules/orchestrator/orchestrator.test.ts",
      "src/modules/runtime/durable.ts",
      "@earendil-works/pi-durable/env/node",
    ]);
    expect(reach("src/modules/runtime/vibevalley.ts")).toEqual([
      "src/modules/runtime/vibevalley.ts",
      "src/modules/runtime/durable.ts",
      "@earendil-works/pi-durable/env/node",
    ]);
  });
});
