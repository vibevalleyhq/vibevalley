import { describe, expect, it } from "vite-plus/test";

import { edgesOf, exportsOf } from "./test-source";

const file = `import type { A } from "./a";
import { type B } from "./b";
import {
  c,
  d } from "#/c.ts";
import * as ns from "./ns";
export * from "./e";
export { f } from "./f";
export type { G } from "./g";
const x = await import("./h");
export const k = 1;
export function m() {}
export type Q = 1;
`;

describe("test-source AST helpers", () => {
  it("sees every import, re-export and dynamic import, over several lines too", () => {
    expect(edgesOf("a.ts", file)).toEqual([
      { from: "./a", typeOnly: true, names: ["A"] },
      { from: "./b", typeOnly: false, names: ["B"] },
      { from: "#/c.ts", typeOnly: false, names: ["c", "d"] },
      { from: "./ns", typeOnly: false, names: ["*"] },
      { from: "./e", typeOnly: false, names: ["*"] },
      { from: "./f", typeOnly: false, names: ["f"] },
      { from: "./g", typeOnly: true, names: ["G"] },
      { from: "./h", typeOnly: false, names: ["*"] },
    ]);
  });

  it("lists what it exports itself", () => {
    expect(exportsOf("a.ts", file)).toEqual(["k", "m", "Q"]);
  });
});
