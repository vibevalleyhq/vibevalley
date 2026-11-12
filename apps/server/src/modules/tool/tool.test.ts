import { describe, expect, it } from "vite-plus/test";

import { setLocale } from "@vibevalley/i18n";
import { endpoints, fieldsOf } from "@vibevalley/protocol/api";

import { htmlSources } from "#/modules/artifact/policy.ts";

import { descriptions, params, sessionDescriptions, spentText } from "./prompts.ts";
import { agentOnly, type Op, parameters, sessionParameters, toolName } from "./schemas.ts";
import { toolStart } from "./tool.ts";

describe("the tools", () => {
  it("tell a helper where an HTML page may load from, from the list its display is written from", () => {
    const hosts = [...new Set(Object.values(htmlSources).flat())].map((u) => new URL(u).host);
    for (const said of [params.artifact.kind, descriptions["artifact.version.create"], sessionDescriptions["artifact.version.create"]])
      expect(hosts.filter((h) => !said.includes(h))).toEqual([]);
  });

  // A tool is its endpoint as a model sees it. Dry runs are the user's: no agent is given one.
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
        const fields = Object.keys(table[op as keyof typeof table].shape);
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
  });

  it("let the orchestrator and a helper say how an html artifact is shown", () => {
    for (const table of [parameters, sessionParameters]) expect(table["artifact.create"].shape).toHaveProperty("display");
    expect(params.artifact.display).toMatch(/slides/u);
  });

  it("read in the trajectory by label and what they name", () => {
    expect(toolStart("issue_create", { title: "加个 README", repo: "demo", start: true })).toEqual({
      text: "记一张工单：demo",
      action: "other",
      tool: "issue_create",
      input: `{"title":"加个 README","repo":"demo","start":true}`,
    });
    expect(toolStart("unknown", undefined).text).toBe("unknown");
  });

  it("are named in the user's language", () => {
    setLocale("en");
    try {
      expect(toolStart("memory_search", { text: "the port" }).text).toBe("Search the memory: the port");
    } finally {
      setLocale("zh");
    }
  });
});
