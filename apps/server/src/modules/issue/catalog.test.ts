import { describe, expect, it } from "vite-plus/test";

import catalogEn from "./template_catalog.en.json";
import catalogZh from "./template_catalog.json";

/** Every leaf but the words: the two languages must agree on ids, numbers, flags and template holes. */
function shape(v: unknown): unknown {
  if (typeof v === "string") return [...v.matchAll(/\{\w+\}|〔/gu)].map((m) => m[0]).join("");
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" ? x : shape(x)]));
  return v;
}

describe("the issue template catalog in each language", () => {
  it("differ only in their words", () => {
    expect(shape(catalogEn)).toEqual(shape(catalogZh));
  });

  it("the English ones are English", () => {
    expect(JSON.stringify(catalogEn)).not.toMatch(/\p{Script=Han}/u);
  });
});
