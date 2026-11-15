import { describe, expect, it } from "vite-plus/test";

import { htmlSources } from "@vibevalley/artifact/html";
import { setLocale } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { endpoints, fieldsOf } from "@vibevalley/protocol/api";

import { orchestrator } from "#/base/actor.ts";
import { world } from "#/testing/world.ts";

import { answers, descriptions, params, sessionDescriptions, spentText } from "./prompts.ts";
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
    expect(params.artifact.display).toMatch(/canvas/u);
  });

  it("formats network and canvas layout warnings separately and preserves Fix: guidance", () => {
    expect(answers.artifact.warned([])).toBe("");
    expect(answers.artifact.warned([{ line: 3, call: "fetch" }])).toBe(
      "\n提醒：第 3 行的脚本用了 fetch。页面连不了网，这部分在用户那里不会动；要用的数据直接写进页面。",
    );
    const layoutOnly = answers.artifact.warned([
      { line: 4, call: "canvas-occlusion", message: "第 4 行的图层 copy 与 pic 重叠了 80px，可能遮挡文字。Fix: 挪开坐标、调整尺寸或加上 allow-overlap" },
    ]);
    expect(layoutOnly).toContain("Fix:");
    expect(layoutOnly).not.toContain("页面连不了网");
    const combined = answers.artifact.warned([
      { line: 3, call: "fetch" },
      {
        line: 4,
        call: "canvas-bounds",
        message: "第 4 行的图层 copy（100,100 800x120）超出了画板范围（800x600）。Fix: 缩小或挪回画板内，或为跨边背景加上 bleed",
      },
    ]);
    expect(combined).toContain("第 3 行的脚本用了 fetch。页面连不了网");
    expect(combined).toContain("第 4 行的图层 copy");
    expect(combined).toContain("Fix:");
  });

  it("returns the layout warning Fix: text when artifact_create receives a canvas with an overlapping layer", async () => {
    await using farm = await world();
    const channels = farm.channel;
    const caller = () => ({
      agent: defaultOrchestrator,
      session: "",
      repo: "",
      here: channels.defaultChannel(),
      picked: "",
      envelope: "",
      actor: orchestrator(true),
    });
    const create = farm.tool.orchestrator(caller).find((item) => item.name === "artifact_create");
    if (create === undefined) throw new Error("artifact_create is missing");
    const result = await create.execute(
      {
        title: "重叠海报",
        kind: "html",
        display: "canvas",
        content: [
          '<vv-board width="1200" height="800">',
          '  <vv-layer id="pic" x="60" y="60" w="300" h="200"><svg></svg></vv-layer>',
          '  <vv-layer id="copy" x="120" y="100" w="400" h="120"><p>Overlap</p></vv-layer>',
          "</vv-board>",
        ].join("\n"),
      },
      { id: "call" },
    );
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    expect(text).toContain("做好了");
    expect(text).toContain("copy");
    expect(text).toContain("pic");
    expect(text).toContain("Fix:");
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
