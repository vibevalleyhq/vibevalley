import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Spent } from "@vibevalley/protocol";
import { describe, expect, it } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { schemas, sessionSchemas } from "./schemas.ts";
import { toolStart } from "./tool.ts";
import { spentText } from "./words.ts";

describe("the tools", () => {
  // The orchestrator's parameters are its prompt's prefix: the bytes in testdata/parameters.json must not drift.
  it("keep their parameters to the byte", () => {
    const kept = readFileSync(resolve(import.meta.dirname, "testdata/parameters.json"), "utf8");
    expect(JSON.stringify({ orchestrator: schemas, session: sessionSchemas })).toBe(kept);
  });

  it("word money", () => {
    expect(spentText({ tokens: 26_000, cny: 0.03 })).toBe("约 ¥0.03 · 2.6 万 token");
    // toFixed rounds halves up.
    expect(spentText({ tokens: 12_500 })).toBe("1.3 万 token");
    const failed = checkCases(goldenCases("tool"), (c) => {
      if (c.fn !== "spentText") throw new Error(`unknown fn ${c.fn}`);
      return spentText(c.in as Spent);
    });
    expect(failed).toEqual([]);
  });

  it("read in the trajectory by label and what they name", () => {
    expect(toolStart("issue_create", { title: "加个 README", project: "demo", start: true })).toEqual({
      text: "记一张工单：demo",
      action: "other",
      tool: "issue_create",
      input: `{"title":"加个 README","project":"demo","start":true}`,
    });
    expect(toolStart("graph_split", { goal: "长".repeat(50) }).text).toBe("拆计划：" + "长".repeat(40) + "…");
    expect(toolStart("unknown", undefined).text).toBe("unknown");
  });
});
