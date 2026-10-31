import { describe, expect, it } from "vite-plus/test";

import { primitivesOf } from "./primitives.ts";

describe("the primitives page", () => {
  it("lists what a file exports by name, with its doc comment's first line, and no types", () => {
    const source = `/** Cuts it.
 * More words. */
export const cut = (s: string) => s;
export function head(s: string) { return s; }
export type T = string;
export interface I {}
const own = 1;
/** Two at once. */
export const a = 1, b = 2;
`;
    expect(primitivesOf("x.ts", source)).toEqual([
      { name: "cut", file: "x.ts", doc: "Cuts it." },
      { name: "head", file: "x.ts", doc: "" },
      { name: "a", file: "x.ts", doc: "Two at once." },
      { name: "b", file: "x.ts", doc: "Two at once." },
    ]);
  });
});
