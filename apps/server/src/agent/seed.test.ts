import { describe, expect, it } from "vite-plus/test";

import seedsEn from "./seeds.en.json";
import seedsZh from "./seeds.json";
import catalogEn from "./template_catalog.en.json";
import catalogZh from "./template_catalog.json";

/** Every leaf but the words: the two languages must agree on ids, numbers, flags, commands and the template holes. */
function shape(v: unknown): unknown {
  if (typeof v === "string") return [...v.matchAll(/\{\w+\}|〔/gu)].map((m) => m[0]).join("");
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" || k === "runtime" || k === "model" ? x : shape(x)]));
  return v;
}

describe("the seeds in each language", () => {
  it("differ only in their words", () => {
    expect(shape(seedsEn)).toEqual(shape(seedsZh));
    expect(shape(catalogEn)).toEqual(shape(catalogZh));
  });

  it("the English ones are English", () => {
    const han = /\p{Script=Han}/u;
    expect(JSON.stringify(seedsEn)).not.toMatch(han);
    expect(JSON.stringify(catalogEn)).not.toMatch(han);
  });
});
