import { describe, expect, it } from "vite-plus/test";

import presetsEn from "#/modules/agent/presets.en.json";
import presetsZh from "#/modules/agent/presets.json";

/** Every leaf but the words: the two languages must agree on ids, numbers, flags and template holes. */
function shape(v: unknown): unknown {
  if (typeof v === "string") return [...v.matchAll(/\{\w+\}|〔/gu)].map((m) => m[0]).join("");
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" || k === "runtime" || k === "model" ? x : shape(x)]));
  return v;
}

describe("the agent presets in each language", () => {
  it("differ only in their words", () => {
    expect(shape(presetsEn)).toEqual(shape(presetsZh));
  });

  it("the English ones are English", () => {
    expect(JSON.stringify(presetsEn)).not.toMatch(/\p{Script=Han}/u);
  });
});
