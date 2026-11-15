import { describe, expect, it } from "vite-plus/test";

import seedsEn from "./seeds.en.json";
import seedsZh from "./seeds.json";

/** Every leaf but the words: the two languages must agree on ids, numbers, flags and template holes. */
function shape(v: unknown): unknown {
  if (typeof v === "string") return [...v.matchAll(/\{\w+\}|〔/gu)].map((m) => m[0]).join("");
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" ? x : shape(x)]));
  return v;
}

describe("the game seeds in each language", () => {
  it("differ only in their words", () => {
    expect(shape(seedsEn)).toEqual(shape(seedsZh));
  });

  it("the English ones are English", () => {
    expect(JSON.stringify(seedsEn)).not.toMatch(/\p{Script=Han}/u);
  });
});
