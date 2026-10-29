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

  it("replays each module's recorded cases in the process", () => {
    const recorded = all.filter((f) => f.endsWith("/recorded.test.ts"));
    expect(recorded.length).toBeGreaterThan(0);
    const leaving = recorded.flatMap((f) => {
      const chain = reach(f);
      return chain ? [chain.join(" → ")] : [];
    });
    expect(leaving).toEqual([]);
  });

  it("follows imports into the workspace's packages", () => {
    expect(reach("src/cli/chat.ts")).toEqual(["src/cli/chat.ts", "../../packages/agent/src/coding.ts", "node:child_process"]);
  });

  it("has a layer for every test file", () => {
    const shape = Object.groupBy(
      all.filter((f) => f.endsWith(".test.ts")),
      (f) => layerOf(f),
    );
    expect(Object.keys(shape).sort()).toEqual(["flow", "module", "rule"]);
  });
});
