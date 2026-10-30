import { describe, expect, it } from "vite-plus/test";

import { hexClass, offTokens } from "./design-tokens.ts";

describe("the workbench's design ladders", () => {
  it("take the tokens and the values on the ladders", () => {
    expect(offTokens("rounded-md rounded-xs text-2xs text-sm duration-120 duration-280 ease-out z-30 -z-10 disabled:opacity-50")).toEqual([]);
    expect(offTokens("shadow-raise shadow-float shadow-[inset_0_2px_0_var(--color-accent)] hover:shadow-raise")).toEqual([]);
  });

  it("name each value off them, in order, behind any variant", () => {
    expect(offTokens("rounded-[10px] md:text-[11px] hover:duration-150 z-50 disabled:opacity-40 ease-[cubic-bezier(0,0,1,1)]")).toEqual([
      "radius",
      "type",
      "motion",
      "layer",
      "disabled",
      "motion",
    ]);
    expect(offTokens("shadow-[0_1px_2px_black] rounded-t-[3px] z-[5]")).toEqual(["shadow", "radius", "layer"]);
  });

  it("do not read a word that only looks like a class", () => {
    expect(offTokens("the run took duration-150 minutes")).toEqual(["motion"]);
    expect(offTokens("max-z-50 notrounded-[1px]")).toEqual([]);
  });

  it("find a colour anywhere inside a class's brackets", () => {
    expect(hexClass.test("bg-[#e3efd2]")).toBe(true);
    expect(hexClass.test("shadow-[0_1px_2px_#2f1f1326]")).toBe(true);
    expect(hexClass.test("bg-wheat/14 shadow-[inset_0_2px_0_var(--color-accent)]")).toBe(false);
  });
});
