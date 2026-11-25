import { describe, expect, it } from "vite-plus/test";

import { ARTIFACT_TYPES } from "@vibevalley/protocol";

import { artifactTypeParityProblems, glyphLabelProblems, ZH_ASCII_ALLOWLIST, zhUntranslatedProblems } from "./i18n.ts";

describe("i18n glyph label anti-regression check", () => {
  it("flags leading and trailing glyph icon substitutes in web.* catalogs", () => {
    const entries = new Map<string, string>([
      ["web.agent.all", "← All profiles"],
      ["web.agent.manage", "Manage library →"],
      ["web.issue.newRepo", "＋ 新建仓库"],
      ["web.issue.newRepoEn", "+ New repo"],
      ["web.dialog.close", "× Close"],
      ["web.dialog.dismiss", "Dismiss ✕"],
    ]);
    const problems = glyphLabelProblems("en", entries);
    expect(problems).toHaveLength(6);
    expect(problems[0]).toContain("web.agent.all");
    expect(problems[1]).toContain("web.agent.manage");
    expect(problems[2]).toContain("web.issue.newRepo");
    expect(problems[3]).toContain("web.issue.newRepoEn");
    expect(problems[4]).toContain("web.dialog.close");
    expect(problems[5]).toContain("web.dialog.dismiss");
  });

  it("exempts web.farm.phone, inline flow strings, dimension strings, and non-web namespaces", () => {
    const entries = new Map<string, string>([
      ["web.farm.phone.controls.help", "←→ move ↑ turn"],
      ["web.issue.issue.changes", "{branch} → {base} · {commits} commits · +{added} -{removed}"],
      ["web.catalog.pixels", "{w} × {h} px"],
      ["web.setting.hint", "Adjust with ⌘+ / ⌘-"],
      ["server.artifact.note", 'Changed: "{old}" → "{new}"'],
    ]);
    expect(glyphLabelProblems("en", entries)).toEqual([]);
  });
});

describe("i18n zh non-acronym ASCII and ArtifactType parity guards", () => {
  it("flags non-whitelisted untranslated ASCII/English entries in zh while allowing whitelisted unit templates", () => {
    const zh = new Map<string, string>([
      ["web.artifact.types.sheet", "Sheet"],
      ["web.audio.metadataRate", "{value} Hz"],
      ["web.audio.customRate", "{value} kHz"],
      ["web.artifact.types.docs", "协作文档"],
      ["shared.join.labeled", "{label}：{text}"],
    ]);
    const en = new Map<string, string>([
      ["web.artifact.types.sheet", "Sheet"],
      ["web.audio.metadataRate", "{value} Hz"],
      ["web.audio.customRate", "{value} kHz"],
      ["web.artifact.types.docs", "Document"],
      ["shared.join.labeled", "{label}: {text}"],
    ]);

    expect(ZH_ASCII_ALLOWLIST.has("web.audio.metadataRate")).toBe(true);
    const problems = zhUntranslatedProblems(zh, en);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("web.artifact.types.sheet");
    expect(problems[1]).toContain("web.audio.customRate");
  });

  it("asserts web.artifact.types.* parity against all 12 ARTIFACT_TYPES", () => {
    expect(ARTIFACT_TYPES).toHaveLength(12);
    const partial = new Map<string, string>([
      ["web.artifact.types.docs", "协作文档"],
      ["web.artifact.types.designSystem", "设计体系"],
    ]);
    const problems = artifactTypeParityProblems("zh", partial);
    expect(problems).toHaveLength(10);
    expect(problems.some((p) => p.includes("web.artifact.types.storyboard"))).toBe(true);
  });
});
