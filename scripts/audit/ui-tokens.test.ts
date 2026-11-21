import { describe, expect, it } from "vite-plus/test";

import { listWebUiFiles, scanAllWebUi, scanUiTokens } from "./ui-tokens.ts";

describe("ui-tokens guardrail", () => {
  it("flags hardcoded hex, rgb/rgba, and hex-alpha template concatenations", () => {
    const file = "apps/mac/ui/vv/web/features/example/Demo.tsx";
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
    const file = "apps/mac/ui/vv/web/ui/Markdown.tsx";
    const src = ["const re = /#(\\d+)\\b/gu;", 'const isHex = (s: string) => s.startsWith("#fff");', 'const url = "#wb-arrow";'].join("\n");
    expect(scanUiTokens(file, src)).toEqual([]);
  });

  it("flags arbitrary Tailwind color, radius, and shadow classes", () => {
    const file = "apps/mac/ui/vv/web/features/example/Demo.tsx";
    const src = 'export const Demo = () => <View class="bg-[#123456] text-[#abcdef] rounded-[9px] shadow-[0_1px_2px_#000]" />;';
    const findings = scanUiTokens(file, src);
    expect(findings.map((f) => f.snippet)).toEqual(["bg-[#123456]", "text-[#abcdef]", "rounded-[9px]", "shadow-[0_1px_2px_#000]"]);
  });

  it("flags raw Switch and role=checkbox outside canonical primitives", () => {
    const bad = 'export const Bad = () => <View><Switch checked /><View role="checkbox" /></View>;';
    expect(scanUiTokens("apps/mac/ui/vv/web/features/agent/AgentsPage.tsx", bad).map((f) => f.snippet)).toEqual(["<Switch", 'role="checkbox"']);
    expect(scanUiTokens("apps/mac/ui/vv/web/ui/layout.tsx", "<Switch checked />")).toEqual([]);
    expect(scanUiTokens("apps/mac/ui/vv/web/ui/Checkbox.tsx", '<Base role="checkbox" />')).toEqual([]);
  });

  it("enforces narrow rule-specific exemptions without blanket-excluding the file", () => {
    const outline = "apps/mac/ui/vv/web/features/pkm/OutlineEditor.tsx";
    const outlineFindings = scanUiTokens(outline, '<View role="checkbox" class="bg-[#112233]" style={{ color: "#abcdef" }} />');
    expect(outlineFindings.map((f) => f.rule)).toEqual(["arbitrary-tailwind", "hardcoded-color"]);

    const connector = "apps/mac/ui/vv/web/features/connector/ConnectorsPage.tsx";
    const connectorFindings = scanUiTokens(connector, '<View style={{ color: "#07c160" }} class="rounded-[9px]"><Switch checked /></View>');
    expect(connectorFindings.map((f) => f.rule)).toEqual(["arbitrary-tailwind", "raw-control"]);
  });

  it("excludes external/export-only files and enforces zero violations across the workbench", () => {
    const files = listWebUiFiles();
    expect(files).not.toContain("apps/mac/ui/vv/web/features/repo/repos.ts");
    expect(files).not.toContain("apps/mac/ui/vv/web/features/artifact/WhiteboardView.tsx");
    expect(files).not.toContain("apps/mac/ui/vv/web/ui/Qr.tsx");

    expect(scanAllWebUi()).toEqual([]);

    const extra = scanUiTokens("apps/mac/ui/vv/web/features/agent/AgentsPage.tsx", 'export const Extra = () => <View style={{ color: "#123456" }} />;');
    expect(extra).toHaveLength(1);
  });
});
