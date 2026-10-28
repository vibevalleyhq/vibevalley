// The pyramid's boundaries (pyramid.ts): the whole farm of the flows is built only in src/flows, and every module's
// rules stay in the process, so a rule test is one in fact and not only in name.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { importsOf, pyramid } from "@vibevalley/testkit/pyramid";

const root = join(import.meta.dirname, "../..");
const { reach, layerOf } = pyramid(root);

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
        : importsOf(readFileSync(join(root, f), "utf8"))
            .filter((s) => s.startsWith(".") && resolve(f, s).startsWith("src/flows/"))
            .map((s) => `${f} imports ${s}`),
    );
    expect(crossing).toEqual([]);
  });

  it("keeps every module's rules and their tests in the process", () => {
    const leaving = all
      .filter((f) => /\/rules(\.test)?\.ts$/.test(f))
      .flatMap((f) => {
        const chain = reach(f);
        return chain ? [chain.join(" → ")] : [];
      });
    expect(leaving).toEqual([]);
  });

  it("has a layer for every test file", () => {
    const shape = Object.groupBy(
      all.filter((f) => f.endsWith(".test.ts")),
      (f) => layerOf(f),
    );
    expect(Object.keys(shape).sort()).toEqual(["flow", "module", "rule"]);
  });
});
