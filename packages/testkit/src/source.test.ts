import { describe, expect, it } from "vite-plus/test";

import { calls, edgesOf, exportsOf, importsOf, readsOf } from "./source.ts";

const file = `import type { A } from "./a";
import { type B } from "./b";
import {
  c,
  d } from "@/c.ts";
import * as ns from "./ns";
export * from "./e";
export { f } from "./f";
export type { G } from "./g";
const x = await import("./h");
const s = core.state();
const { issues, crons } = core.state();
const n = core.state()?.sessions;
s.connectors;
core.session("w1");
export const k = 1;
export function m() {}
export type Q = 1;
`;

describe("a source file's edges", () => {
  it("sees every import, re-export and dynamic import, over several lines too", () => {
    expect(edgesOf("a.ts", file)).toEqual([
      { from: "./a", typeOnly: true, names: ["A"] },
      { from: "./b", typeOnly: false, names: ["B"] },
      { from: "@/c.ts", typeOnly: false, names: ["c", "d"] },
      { from: "./ns", typeOnly: false, names: ["*"] },
      { from: "./e", typeOnly: false, names: ["*"] },
      { from: "./f", typeOnly: false, names: ["f"] },
      { from: "./g", typeOnly: true, names: ["G"] },
      { from: "./h", typeOnly: false, names: ["*"] },
    ]);
    // Under verbatimModuleSyntax `import { type B }` still loads ./b.
    expect(importsOf("a.ts", file)).toEqual(["./b", "@/c.ts", "./ns", "./e", "./f", "./h"]);
  });

  it("lists what it exports itself", () => {
    expect(exportsOf("a.ts", file)).toEqual(["k", "m", "Q"]);
  });

  it("reads fields off a call directly, through a const and destructured", () => {
    expect(readsOf("a.ts", file, "core", "state").toSorted()).toEqual(["connectors", "crons", "issues", "sessions"]);
    expect([calls("a.ts", file, "core", "session"), calls("a.ts", file, "core", "apply")]).toEqual([true, false]);
  });
});
