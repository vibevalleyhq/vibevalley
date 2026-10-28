import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Spent } from "@vibevalley/protocol";
import { setLocale } from "@vibevalley/protocol/words";
import { describe, expect, it } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import { endpoints, fieldsOf } from "@vibevalley/protocol/api";
import { agentOnly, type Op, parameters, schemas, sessionParameters, sessionSchemas, toolName } from "./schemas.ts";
import { toolStart } from "./tool.ts";
import { spentText } from "./prompts.ts";

describe("the tools", () => {
  // The orchestrator's parameters are its prompt's prefix: the bytes in testdata/parameters.json must not drift.
  it("keep their parameters to the byte", () => {
    const kept = readFileSync(resolve(import.meta.dirname, "testdata/parameters.json"), "utf8");
    expect(JSON.stringify({ orchestrator: schemas, session: sessionSchemas })).toBe(kept);
  });

  // A tool is its endpoint as a model sees it: named by it, taking its fields (or ones only a model uses), given to those
  // its can names, and every endpoint an agent may call is a tool. Dry runs are the owner's: no agent is given one.
  it("are their endpoints: named by them, with their fields, for those their can names", () => {
    const dryRuns = new Set(endpoints.flatMap((e) => (e.dryRun ? [e.dryRun] : [])));
    for (const [caller, table] of [
      ["orchestrator", parameters],
      ["session", sessionParameters],
    ] as const) {
      const ops = Object.keys(table) as Op[];
      for (const op of ops) {
        const e = endpoints.find((x) => x.op === op);
        expect({ op, can: e?.can.includes(caller) }).toEqual({ op, can: true });
        const fields = Object.keys(table[op as keyof typeof table].fields);
        const allowed = new Set([...fieldsOf(e!), ...(agentOnly[op] ?? [])]);
        expect({ op, extra: fields.filter((f) => !allowed.has(f)) }).toEqual({ op, extra: [] });
      }
      const owed = endpoints.filter((e) => e.can.includes(caller) && !dryRuns.has(e.op)).map((e) => e.op);
      expect({ caller, missing: owed.filter((op) => !ops.includes(op)) }).toEqual({ caller, missing: [] });
    }
    expect(toolName("channel.message.send")).toBe("channel_message_send");
    expect(toolName("issue.status.previewUpdate")).toBe("issue_status_preview_update");
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

  it("are named in the owner's language", () => {
    setLocale("en");
    try {
      expect(toolStart("memory_search", { text: "the port" }).text).toBe("Search the memory: the port");
    } finally {
      setLocale("zh");
    }
  });
});
