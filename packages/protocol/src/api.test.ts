import { describe, expect, test } from "vite-plus/test";

import { endpoints, fieldsOf, pathOf } from "./api";

// What a word may end in: s is a plural, the words that end so in the singular aside (status, and MOSS Live's name).
const singular = (word: string) => !word.endsWith("s") || word === "status" || word === "moss";

describe("the endpoint table", () => {
  test("names every op <module>[.<noun>].<verb>, in the singular, at its own path", () => {
    const off = endpoints
      .map((e) => e.op)
      .filter((op) => {
        const words = op.split(".");
        const shaped = words.length >= 2 && words.length <= 3 && words.every((w) => /^[a-z][A-Za-z]*$/u.test(w));
        return !shaped || !words.slice(0, -1).every(singular);
      });
    expect(off).toEqual([]);
    expect(new Set(endpoints.map((e) => pathOf(e.op))).size).toBe(endpoints.length);
    expect(pathOf("issue.status.update")).toBe("/api/v1/issue/status/update");
  });

  test("names each dry run after its op, preview before the verb", () => {
    const wrong = endpoints
      .filter((e) => e.dryRun)
      .filter((e) => {
        const words = e.op.split(".");
        const verb = words.pop()!;
        return e.dryRun !== [...words, "preview" + verb[0]!.toUpperCase() + verb.slice(1)].join(".");
      })
      .map((e) => `${e.op} → ${e.dryRun}`);
    expect(wrong).toEqual([]);
  });

  test("says an input with an id is about it, but where the server gives the id", () => {
    const unsaid = endpoints.filter((e) => !e.op.endsWith(".create") && fieldsOf(e).includes("id") && !e.about.includes("id")).map((e) => e.op);
    expect(unsaid).toEqual([]);
  });

  test("says what each input is about only with fields the input has", () => {
    const missing = endpoints
      .filter((e) => e.about.length > 0)
      .filter((e) => e.about.some((f) => !fieldsOf(e).includes(f)))
      .map((e) => e.op);
    expect(missing).toEqual([]);
  });
});
