import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { ARTIFACT_TYPE_SPECS, ARTIFACT_TYPES, ArtifactTypeValues, userId } from "@vibevalley/protocol";

import { decodeBase64Utf8 } from "../../infra/attachment";
import { formatGenUiAction } from "../../infra/rich";
import { artifactTypeIcon, artifactTypeLabel } from "./ArtifactCard";
import { artifactSuffixOf, buildOutlineFromMarkdown, entryPathOf, inferArtifactFromName } from "./html";
import { presenceHighlightCommand } from "./shell";

test("covers all 12 ArtifactType metadata entries, labels, icons, suffixes, and entry paths", () => {
  expect(ArtifactTypeValues).toHaveLength(12);
  expect(ARTIFACT_TYPES).toEqual(ArtifactTypeValues);
  expect(Object.keys(ARTIFACT_TYPE_SPECS)).toEqual([...ARTIFACT_TYPES]);
  for (const type of ARTIFACT_TYPES) {
    const spec = ARTIFACT_TYPE_SPECS[type];
    expect(spec.artifactType).toBe(type);
    expect(artifactTypeLabel(type).length).toBeGreaterThan(0);
    expect(artifactTypeIcon[type].length).toBeGreaterThan(0);
    expect(artifactSuffixOf({ artifactType: type })).toBe(spec.exportSuffix);
    expect(entryPathOf(type)).toBe(spec.entryPath);
    expect(entryPathOf(type)).toMatch(/^structure\//u);
  }
});

test("regression: all 12 ArtifactType labels render localized Chinese without English fallback", () => {
  setLocale("zh");
  try {
    const labels = ARTIFACT_TYPES.map((type) => [type, artifactTypeLabel(type)] as const);
    for (const [, label] of labels) {
      expect(label).toMatch(/\p{Script=Han}/u);
    }
    expect(new Map(labels).get("sheet")).toBe("电子表格");
    expect(new Map(labels).get("prototype")).toBe("交互原型");
    expect(new Map(labels).get("diagram")).toBe("结构图表");
    expect(new Map(labels).get("storyboard")).toBe("分镜脚本");
  } finally {
    setLocale("en");
  }
});

test("infers all 12 artifact types from filenames and content", () => {
  expect(inferArtifactFromName("q3-deck.slides.json")).toEqual({ title: "q3-deck", artifactType: "slides" });
  expect(inferArtifactFromName("poster.design.json")).toEqual({ title: "poster", artifactType: "design" });
  expect(inferArtifactFromName("kpi.dashboard.json")).toEqual({ title: "kpi", artifactType: "dashboard" });
  expect(inferArtifactFromName("intro.motion.json")).toEqual({ title: "intro", artifactType: "motion" });
  expect(inferArtifactFromName("pipeline.whiteboard.json")).toEqual({ title: "pipeline", artifactType: "whiteboard" });
  expect(inferArtifactFromName("brand.tokens.json")).toEqual({ title: "brand", artifactType: "design-system" });
  expect(inferArtifactFromName("budget.sheet.json")).toEqual({ title: "budget", artifactType: "sheet" });
  expect(inferArtifactFromName("arch.diagram.json")).toEqual({ title: "arch", artifactType: "diagram" });
  expect(inferArtifactFromName("launch.storyboard.json")).toEqual({ title: "launch", artifactType: "storyboard" });
  expect(inferArtifactFromName("weekly.outline.json")).toEqual({ title: "weekly", artifactType: "outline" });
  expect(inferArtifactFromName("weekly.outline.md")).toEqual({ title: "weekly", artifactType: "outline" });
  expect(inferArtifactFromName("demo.html")).toEqual({ title: "demo", artifactType: "prototype" });
  expect(inferArtifactFromName("notes.doc.md")).toEqual({ title: "notes", artifactType: "docs" });
  expect(inferArtifactFromName("plain", "<!doctype html><main>Hi</main>")).toEqual({ title: "plain", artifactType: "prototype" });
});

test("buildOutlineFromMarkdown creates valid structure/outline.json tree", () => {
  const doc = buildOutlineFromMarkdown("Launch", "## Roadmap\n- Ship UI\n- [x] Run checks\n");
  expect(doc.version).toBe(1);
  expect(doc.rootIds).toHaveLength(1);
  const rootId = doc.rootIds[0];
  expect(rootId).toBeDefined();
  const root = rootId !== undefined ? doc.nodes[rootId] : undefined;
  expect(root?.kind).toBe("heading");
  expect(root?.text).toBe("Roadmap");
  expect(root?.children).toHaveLength(2);
  const secondId = root?.children[1];
  expect(secondId !== undefined ? doc.nodes[secondId]?.checked : undefined).toBe(true);
});

test("presenceHighlightCommand filters local user, scopes by path, and normalizes highlight colors", () => {
  const cmd = presenceHighlightCommand(
    [
      { id: userId, name: "Me", kind: "highlight", selector: "#local", updatedAt: 1 },
      {
        id: "session:1",
        name: "老周",
        color: "coral",
        kind: "highlight",
        selector: ".kpi-card",
        status: "核对指标",
        path: "structure/slides/01.json",
        updatedAt: 2,
      },
      { id: "session:2", name: "小美", color: "#2f9d8f", kind: "cursor", x: 120, y: 80, w: 64, h: 32, path: "structure/slides/02.json", updatedAt: 3 },
      { id: "session:3", name: "助手", color: "teal", kind: "selection", x: 10, y: 20, updatedAt: 4 },
    ],
    { path: "structure/slides/01.json" },
  );
  expect(cmd).toEqual({
    vibevalley: "presence-highlight",
    items: [
      { id: "session:1", name: "老周", color: "#d9774f", selector: ".kpi-card", status: "核对指标" },
      { id: "session:3", name: "助手", color: "#2f9d8f", x: 10, y: 20 },
    ],
  });
});

test("decodes UTF-8 base64 markdown and formats GenUI action payloads cleanly", () => {
  const md = "# 大纲导入\n- [ ] 验证 UTF-8 编码";
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(md)));
  expect(decodeBase64Utf8(b64)).toBe(md);

  expect(formatGenUiAction({ action: "state_change", payload: "rate=7.5" })).toBe("rate=7.5");
  expect(formatGenUiAction({ action: "submit", payload: "approved=true" })).toBe("submit: approved=true");
  expect(formatGenUiAction({ action: "confirm", payload: "" })).toBe("confirm");
  expect(formatGenUiAction({ action: "", payload: "fallback" })).toBe("fallback");
});
