import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { checkCases, goldenCasesAt, jsonDiff } from "./golden.ts";
import { tempDir } from "./temp.ts";

const file = (rows: object[]) => {
  const path = join(tempDir("golden-"), "rules.jsonl.gz");
  writeFileSync(path, gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  return path;
};

afterEach(() => {
  delete process.env.VIBEVALLEY_GOLDEN;
});

describe("golden cases", () => {
  it("say where a rule disagrees, and a key holding undefined is no key", () => {
    const cases = goldenCasesAt(
      file([
        { fn: "double", in: 2, out: 4 },
        { fn: "double", in: 3, out: 7 },
      ]),
    );
    expect(checkCases(cases, (c) => (c.in as number) * 2)).toEqual(["line 2 double(3): .: got 6, want 7"]);
    expect(jsonDiff({ a: 1, b: undefined }, { a: 1 })).toBeUndefined();
  });

  it("write the rule's answers back on update", () => {
    const path = file([{ fn: "double", in: 3, out: 7 }]);
    process.env.VIBEVALLEY_GOLDEN = "update";
    expect(checkCases(goldenCasesAt(path), (c) => (c.in as number) * 2)).toEqual([]);
    expect(JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"))).toEqual({ fn: "double", in: 3, out: 6 });
  });
});
