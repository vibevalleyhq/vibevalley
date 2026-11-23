import { describe, expect, it } from "vite-plus/test";

import { listWebUiFiles, scanAllWebUi, scanUiTokens } from "./ui-tokens.ts";

describe("ui-tokens guardrail", () => {
  it("flags hardcoded hex, rgb/rgba, and hex-alpha template concatenations", () => {
    const file = "apps/mac/ui/features/example/Demo.tsx";
    const src = [
      'const c = "#ff00aa";',
      "export function Demo(props: { hat: string }) {",
      '  return <View style={{ backgroundColor: `${props.hat}29`, borderColor: "rgba(0,0,0,0.2)" }} />;',
      "}",
    ].join("\n");
    const findings = scanUiTokens(file, src);
    expect(findings.map((f) => ({ line: f.line, rule: f.rule, snippet: f.snippet }))).toEqual([
      { line: 1, rule: "hardcoded-color", snippet: "#ff00aa" },
      { line: 3, rule: "hardcoded-color", snippet: "${props.hat}29" },
      { line: 3, rule: "hardcoded-color", snippet: "rgba(" },
    ]);
  });

  it("ignores regexes and string parsing helpers", () => {
    const file = "apps/mac/ui/design/Markdown.tsx";
    const src = ["const re = /#(\\d+)\\b/gu;", 'const isHex = (s: string) => s.startsWith("#fff");', 'const url = "#wb-arrow";'].join("\n");
    expect(scanUiTokens(file, src)).toEqual([]);
  });

  it("flags arbitrary Tailwind color, radius, and shadow classes", () => {
    const file = "apps/mac/ui/features/example/Demo.tsx";
    const src = 'export const Demo = () => <View class="bg-[#123456] text-[#abcdef] rounded-[9px] shadow-[0_1px_2px_#000]" />;';
    const findings = scanUiTokens(file, src);
    expect(findings.map((f) => f.snippet)).toEqual(["bg-[#123456]", "text-[#abcdef]", "rounded-[9px]", "shadow-[0_1px_2px_#000]"]);
  });

  it("flags raw Switch and role=checkbox outside canonical primitives", () => {
    const bad = 'export const Bad = () => <View><Switch checked /><View role="checkbox" /></View>;';
    expect(scanUiTokens("apps/mac/ui/features/agent/AgentsPage.tsx", bad).map((f) => f.snippet)).toEqual(["<Switch", 'role="checkbox"']);
    expect(scanUiTokens("apps/mac/ui/design/layout.tsx", "<Switch checked />")).toEqual([]);
    expect(scanUiTokens("apps/mac/ui/design/Checkbox.tsx", '<Base role="checkbox" />')).toEqual([]);
  });

  it("enforces narrow rule-specific exemptions without blanket-excluding the file", () => {
    const connector = "apps/mac/ui/features/connector/ConnectorsPage.tsx";
    const connectorFindings = scanUiTokens(connector, '<View style={{ color: "#07c160" }} class="rounded-[9px]"><Switch checked /></View>');
    expect(connectorFindings.map((f) => f.rule)).toEqual(["arbitrary-tailwind", "raw-control"]);
  });

  it("excludes external/export-only files and enforces zero violations across the workbench", () => {
    const files = listWebUiFiles();
    expect(files).not.toContain("apps/mac/ui/features/repo/repos.ts");
    expect(files).not.toContain("apps/mac/ui/features/artifact/WhiteboardView.tsx");
    expect(files).not.toContain("apps/mac/ui/design/Qr.tsx");

    expect(scanAllWebUi()).toEqual([]);

    const extra = scanUiTokens("apps/mac/ui/features/agent/AgentsPage.tsx", 'export const Extra = () => <View style={{ color: "#123456" }} />;');
    expect(extra).toHaveLength(1);
  });

  it("flags conditional border thickness and geometry shifts on interactive elements", () => {
    const file = "apps/mac/ui/features/example/Demo.tsx";
    const src = [
      "export function Demo(props: { picked: boolean }) {",
      '  return <View role="button" class={props.picked ? "border-2 border-accent" : "border border-line"} />;',
      "}",
      "export function Thumb(props: { selected: boolean }) {",
      '  return <View role="button" class="border border-line" style={props.selected ? { borderWidth: 2 } : undefined} />;',
      "}",
      "export function PaddingProp(props: { active: boolean }) {",
      "  return <View style={{ paddingVertical: props.active ? 3 : 0 }} />;",
      "}",
    ].join("\n");
    const findings = scanUiTokens(file, src);
    expect(findings.map((f) => ({ line: f.line, rule: f.rule }))).toEqual([
      { line: 2, rule: "selection-layout-shift" },
      { line: 5, rule: "selection-layout-shift" },
      { line: 8, rule: "selection-layout-shift" },
    ]);
  });

  it("allows constant border thickness, row dividers, dashed borders, and fixed dots", () => {
    const file = "apps/mac/ui/features/example/Demo.tsx";
    const src = [
      "export function Card(props: { active: boolean; last: boolean; dashed: boolean; saved?: boolean }) {",
      "  return (",
      "    <>",
      '      <View role="button" class={`rounded-md border ${props.active ? "border-accent bg-selected" : "border-transparent hover:bg-hover"}`} />',
      '      <View class={`py-1 ${props.last ? "" : "border-b border-line"}`} />',
      '      <View class={props.dashed ? "border border-dashed border-line" : ""} />',
      '      <View class={`h-2 w-2 rounded-full ${props.saved ? "bg-leaf" : "border border-faint"}`} />',
      "    </>",
      "  );",
      "}",
    ].join("\n");
    expect(scanUiTokens(file, src)).toEqual([]);
  });

  it("scans workspace surfaces and components while permitting static size props", () => {
    const files = listWebUiFiles();
    expect(files).toContain("apps/mac/ui/workspace/Sidebar.tsx");
    expect(files).toContain("apps/mac/ui/workspace/chrome.tsx");
    expect(files).toContain("apps/mac/ui/design/Button.tsx");

    const badHost = [
      "export function Row(props: { showActiveCard: boolean }) {",
      '  return <View style={{ paddingVertical: props.showActiveCard ? 3 : 0, borderColor: "rgba(0,0,0,0.08)" }} />;',
      "}",
    ].join("\n");
    expect(scanUiTokens("apps/mac/ui/workspace/Sidebar.tsx", badHost).map((f) => f.rule)).toEqual(["selection-layout-shift", "hardcoded-color"]);

    const goodHost = [
      "export function PanelEmpty(props: { text: string; compact?: boolean }) {",
      '  return <Text class={`px-3 text-xs leading-relaxed text-muted ${props.compact === true ? "py-1.5" : "py-2.5"}`}>{props.text}</Text>;',
      "}",
    ].join("\n");
    expect(scanUiTokens("apps/mac/ui/workspace/chrome.tsx", goodHost)).toEqual([]);
  });

  it("flags color transitions that animate on light/dark theme switches while allowing managed transform/opacity/shadow transitions", () => {
    const file = "apps/mac/ui/design/Button.tsx";
    const bad = [
      'const cls = "rounded-md border border-line bg-page transition duration-120 ease-out";',
      "export function Demo() {",
      '  return <View class="bg-page transition-colors duration-180 ease-out" style={{ transitionProperty: "colors,shadow" }} />;',
      "}",
    ].join("\n");
    expect(scanUiTokens(file, bad).map((f) => ({ line: f.line, rule: f.rule }))).toEqual([
      { line: 1, rule: "color-transition" },
      { line: 3, rule: "color-transition" },
      { line: 3, rule: "color-transition" },
    ]);

    const good = [
      "export function Good() {",
      '  return <View class={`rounded-md bg-page ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px`} style={motionOff() ? undefined : { transitionProperty: "shadow", transitionDuration: motionDuration(180) }} />;',
      "}",
    ].join("\n");
    expect(scanUiTokens(file, good)).toEqual([]);
  });

  it("flags raw transition-*, animate-*, animation=fade, popup starting/ending classes, and inline transitionDuration outside design/motion.ts", () => {
    const file = "apps/mac/ui/design/Dialog.tsx";
    const bad = [
      "export function Bad() {",
      '  return <Dialog animation="fade" popupStartingClass="opacity-0" class="transition-transform duration-120 ease-out animate-pulse" style={{ transitionProperty: "transform", transitionDuration: 120 }} />;',
      "}",
    ].join("\n");
    expect(scanUiTokens(file, bad).map((f) => ({ rule: f.rule, snippet: f.snippet }))).toEqual([
      { rule: "unmanaged-motion", snippet: 'animation="fade"' },
      { rule: "unmanaged-motion", snippet: 'popupStartingClass="opacity-0"' },
      { rule: "unmanaged-motion", snippet: "transition-transform" },
      { rule: "unmanaged-motion", snippet: "animate-pulse" },
      { rule: "unmanaged-motion", snippet: 'transitionProperty: "transform"' },
      { rule: "unmanaged-motion", snippet: "transitionDuration: 120" },
    ]);

    const good = [
      "export function Good() {",
      '  return <Dialog animation={fadeAnimation()} popupStartingClass={popupTransition("opacity-0")} class={`${motionClass("transition-opacity duration-120 ease-out")} ${motionClass("animate-pulse")}`} />;',
      "}",
    ].join("\n");
    expect(scanUiTokens(file, good)).toEqual([]);
  });
});
