import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Spent } from "@vibevalley/protocol";
import { describe, expect, it } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { schemas } from "./schemas.ts";
import { toolStart } from "./tool.ts";
import { spentText } from "./words.ts";

describe("the tools", () => {
  // The manager's parameters are its prompt's prefix: the contract kept (testdata/tool_schemas.json).
  it("keep the manager's parameters", () => {
    const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, "testdata/tool_schemas.json"), "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(baseline).sort());
    // Omitted additionalProperties lets unknown fields through as true does.
    for (const [name, want] of Object.entries(baseline))
      expect({ name, schema: schemas[name] }).toEqual({ name, schema: { ...want, additionalProperties: true } });
  });

  it("word money", () => {
    expect(spentText({ tokens: 26_000, cny: 0.03 } as Spent)).toBe("约 ¥0.03 · 2.6 万 token");
    // toFixed rounds halves up.
    expect(spentText({ tokens: 12_500 } as Spent)).toBe("1.3 万 token");
    const failed = checkCases(goldenCases("tool"), (c) => {
      if (c.fn !== "spentText") throw new Error(`unknown fn ${c.fn}`);
      return spentText(c.in as Spent);
    });
    expect(failed).toEqual([]);
  });

  it("read in the trajectory by label and what they name", () => {
    expect(toolStart("dispatch", { brief: "加个 README", project: "demo" })).toEqual({
      text: "派活：demo",
      action: "other",
      tool: "dispatch",
      input: `{"brief":"加个 README","project":"demo"}`,
    });
    expect(toolStart("graph_split", { goal: "长".repeat(50) }).text).toBe("拆计划：" + "长".repeat(40) + "…");
    expect(toolStart("unknown", undefined).text).toBe("unknown");
  });
});
