import { describe, expect, test } from "nsh/test";

import type { OutlineDocument } from "../html";
import {
  addOutlineChild,
  addOutlineRootItem,
  addOutlineSibling,
  buildDashboardChartSpec,
  computeDashboardKpi,
  computeSheetNumericTotals,
  countOutlineTodos,
  cycleOutlineKind,
  type DashboardDataset,
  deleteOutlineNode,
  diagramToMermaid,
  evaluateMotionLayer,
  flattenOutline,
  indentOutlineNode,
  outdentOutlineNode,
  parseDesignFrame,
  parseDesignSystem,
  parseStoryboard,
  resolveDesignColor,
  resolveDesignExpr,
  updateOutlineText,
} from "./previewModel";

describe("computeDashboardKpi", () => {
  const datasets = new Map<string, DashboardDataset>([
    [
      "structure/data/sample.json",
      {
        path: "structure/data/sample.json",
        name: "sample.json",
        schema: [
          { name: "availability", label: "Availability", type: "number" },
          { name: "p99Ms", label: "P99", type: "number" },
          { name: "alerts", label: "Alerts", type: "number" },
        ],
        cols: ["availability", "p99Ms", "alerts"],
        rows: [
          { availability: 99.9, p99Ms: 12, alerts: 1 },
          { availability: 99.8, p99Ms: 28, alerts: 2 },
          { availability: 100, p99Ms: 20, alerts: 0 },
        ],
      },
    ],
  ]);

  test("computes avg, sum, min, max, count and formats percent/number", () => {
    expect(
      computeDashboardKpi({ id: "k1", format: "percent", source: { dataset: "structure/data/sample.json", field: "availability", agg: "avg" } }, datasets)
        .formatted,
    ).toBe("99.9%");

    expect(
      computeDashboardKpi({ id: "k2", format: "number", source: { dataset: "structure/data/sample.json", field: "p99Ms", agg: "max" } }, datasets).formatted,
    ).toBe("28");

    expect(
      computeDashboardKpi({ id: "k3", format: "number", source: { dataset: "structure/data/sample.json", field: "p99Ms", agg: "min" } }, datasets).formatted,
    ).toBe("12");

    expect(
      computeDashboardKpi({ id: "k4", format: "number", source: { dataset: "structure/data/sample.json", field: "alerts", agg: "sum" } }, datasets).formatted,
    ).toBe("3");

    expect(
      computeDashboardKpi({ id: "k5", format: "number", source: { dataset: "structure/data/sample.json", field: "alerts", agg: "count" } }, datasets).formatted,
    ).toBe("3");
  });

  test("returns fallback dash when dataset or field is missing", () => {
    expect(computeDashboardKpi({ id: "missing", source: { dataset: "structure/data/none.json", field: "x", agg: "avg" } }, datasets).formatted).toBe("—");
  });
});

describe("diagramToMermaid", () => {
  test("renders flowchart, sequence, and state-machine diagrams with sanitized ids", () => {
    const flow = diagramToMermaid({
      title: "Architecture",
      kind: "architecture",
      direction: "LR",
      nodes: [
        { id: "gw-1", label: 'API "Edge"', kind: "gateway" },
        { id: "db", label: "Primary DB", kind: "database" },
      ],
      edges: [{ id: "e1", from: "gw-1", to: "db", label: "queries" }],
    });
    expect(flow).toContain("flowchart LR");
    expect(flow).toContain("gw_1{\"API 'Edge'\"}");
    expect(flow).toContain('db[("Primary DB")]');
    expect(flow).toContain('gw_1 -->|"queries"| db');

    const seq = diagramToMermaid({
      title: "RPC",
      kind: "sequence",
      direction: "LR",
      nodes: [
        { id: "c", label: "Client", kind: "client" },
        { id: "s", label: "Server", kind: "service" },
      ],
      edges: [{ id: "e1", from: "c", to: "s", label: "POST" }],
    });
    expect(seq).toContain("sequenceDiagram");
    expect(seq).toContain("c->>s: POST");

    const sm = diagramToMermaid({
      title: "States",
      kind: "state-machine",
      direction: "LR",
      nodes: [
        { id: "a", label: "Draft", kind: "state" },
        { id: "b", label: "Done", kind: "terminal" },
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "finish" }],
    });
    expect(sm).toContain("stateDiagram-v2");
    expect(sm).toContain("a --> b : finish");
  });
});

describe("outline tree helpers", () => {
  test("updates text, cycles kinds, indents/outdents, deletes recursively, and counts todos", () => {
    let doc: OutlineDocument = { version: 1, rootIds: [], nodes: {} };
    doc = addOutlineRootItem(doc, "n1", "Heading", "heading");
    doc = addOutlineRootItem(doc, "n2", "First", "bullet");
    doc = addOutlineSibling(doc, "n2", "n3", "Second");
    doc = cycleOutlineKind(doc, "n3");
    expect(doc.nodes.n3?.kind).toBe("todo");
    expect(countOutlineTodos(doc)).toEqual({ done: 0, total: 1 });

    doc = indentOutlineNode(doc, "n3");
    expect(doc.rootIds).toEqual(["n1", "n2"]);
    expect(doc.nodes.n2?.children).toEqual(["n3"]);

    doc = addOutlineChild(doc, "n3", "n4", "Child");
    doc = updateOutlineText(doc, "n4", "Updated child");
    expect(flattenOutline(doc).map((r) => [r.node.id, r.depth])).toEqual([
      ["n1", 0],
      ["n2", 0],
      ["n3", 1],
      ["n4", 2],
    ]);
    expect(doc.nodes.n4?.text).toBe("Updated child");

    doc = outdentOutlineNode(doc, "n3");
    expect(doc.rootIds).toEqual(["n1", "n2", "n3"]);

    doc = deleteOutlineNode(doc, "n3");
    expect(doc.rootIds).toEqual(["n1", "n2"]);
    expect(doc.nodes.n3).toBeUndefined();
    expect(doc.nodes.n4).toBeUndefined();
  });
});

describe("structured visual preview helpers", () => {
  test("buildDashboardChartSpec builds line chart for temporal series and bar chart for categorical data", () => {
    const lineSpec = buildDashboardChartSpec({
      path: "structure/data/slo.json",
      name: "slo.json",
      schema: [
        { name: "day", label: "Day", type: "string" },
        { name: "p99Ms", label: "P99 ms", type: "number" },
      ],
      cols: ["day", "p99Ms"],
      rows: [
        { day: "Mon", p99Ms: 18 },
        { day: "Tue", p99Ms: 24 },
      ],
    });
    expect(lineSpec).toBeDefined();
    const parsedLine = JSON.parse(lineSpec ?? "{}") as { type?: string; categories?: string[] };
    expect(parsedLine.type).toBe("line");
    expect(parsedLine.categories).toEqual(["Mon", "Tue"]);

    const barSpec = buildDashboardChartSpec({
      path: "structure/data/engines.json",
      name: "engines.json",
      schema: [
        { name: "engine", label: "Engine", type: "string" },
        { name: "qps", label: "QPS", type: "number" },
      ],
      cols: ["engine", "qps"],
      rows: [
        { engine: "Rust", qps: 1200 },
        { engine: "Node", qps: 450 },
      ],
    });
    const parsedBar = JSON.parse(barSpec ?? "{}") as { type?: string };
    expect(parsedBar.type).toBe("bar");
  });

  test("parseDesignFrame parses canonical root+props schema and resolves expressions and colors", () => {
    const raw = JSON.stringify({
      id: "desktop",
      name: "Desktop",
      viewport: { w: 1280, h: 800 },
      theme: "dark",
      props: [{ name: "cta", label: "CTA", type: "text", value: "Deploy Now" }],
      root: {
        id: "root",
        kind: "stack",
        direction: "vertical",
        fill: "{color.surface}",
        children: [{ id: "btn", kind: "button", text: "{props.cta}", fill: "{color.accent}" }],
      },
    });
    const frame = parseDesignFrame("structure/frames/desktop.json", raw);
    expect(frame.width).toBe(1280);
    expect(frame.theme).toBe("dark");
    expect(frame.props).toHaveLength(1);
    expect(frame.root?.children[0]?.text).toBe("{props.cta}");
    expect(resolveDesignExpr("{props.cta}", { cta: "Ship It" })).toBe("Ship It");
    expect(resolveDesignColor("{color.accent}", "dark")).toBe("#7fae4f");
  });

  test("parseDesignSystem handles canonical array tokens and component variant objects", () => {
    const tokens = JSON.stringify({
      name: "Papertrails",
      version: "2.0.0",
      defaultTheme: "light",
      color: [{ id: "accent", group: "brand", value: { light: "#4d7a2a", dark: "#84cc16" }, note: "Primary" }],
      type: { scale: [{ id: "xl", value: "24px" }], styles: [{ id: "heading", size: "{xl}", weight: 700, lineHeight: 1.2 }] },
      space: [{ id: "4", value: "16px" }],
      radius: [{ id: "md", value: "8px" }],
    });
    const comp = JSON.stringify({
      id: "button",
      title: "Button",
      variants: [{ id: "primary", bg: "{color.accent}", fg: "{color.surface}" }],
      states: ["default", "hover"],
      guidelines: { do: ["Keep short"], dont: ["Stack two primaries"] },
    });
    const ds = parseDesignSystem(tokens, [{ path: "structure/components/button.json", content: comp }], "DS");
    expect(ds.colors[0]?.light).toBe("#4d7a2a");
    expect(ds.styles[0]?.size).toBe("24px");
    expect(ds.components[0]?.variants[0]?.id).toBe("primary");
    expect(ds.components[0]?.guidelinesDo).toEqual(["Keep short"]);
  });

  test("evaluateMotionLayer, parseStoryboard, and computeSheetNumericTotals behave deterministically", () => {
    const start = evaluateMotionLayer({ opacity: 1 }, 0);
    const settled = evaluateMotionLayer({ opacity: 0.8 }, 0.5);
    expect(start.opacity).toBe(0);
    expect(settled.opacity).toBe(0.8);
    expect(settled.offsetY).toBe(0);

    const sb = parseStoryboard(
      JSON.stringify({
        aspectRatio: "16:9",
        fps: 24,
        styleGuide: { visualTone: "Warm", palette: ["#fcfcfb"] },
        shots: [{ id: "sh01", scene: "Hook", durationSec: 2.5, framing: "wide", camera: "pan", visual: "Desk", sfx: "chime", status: "ready" }],
      }),
      "Demo",
    );
    expect(sb.shots[0]?.sfx).toBe("chime");

    const totals = computeSheetNumericTotals(
      [
        { key: "name", title: "Name", type: "string" },
        { key: "score", title: "Score", type: "number" },
      ],
      [
        { name: "A", score: 12.5 },
        { name: "B", score: 7.5 },
      ],
    );
    expect(totals.get("score")).toBe("20");
  });
});
