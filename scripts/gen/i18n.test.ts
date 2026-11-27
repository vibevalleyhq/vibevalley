import { describe, expect, it } from "vite-plus/test";

import { NOTE_TYPES } from "@vibevalley/protocol";

import { glyphLabelProblems, noteTypeParityProblems, ZH_ASCII_ALLOWLIST, zhUntranslatedProblems } from "./i18n.ts";

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
      ["web.media.dimensions", "{w} × {h} px"],
      ["web.setting.hint", "Adjust with ⌘+ / ⌘-"],
      ["server.note.note", 'Changed: "{old}" → "{new}"'],
    ]);
    expect(glyphLabelProblems("en", entries)).toEqual([]);
  });
});

describe("i18n zh non-acronym ASCII and NoteType parity guards", () => {
  it("flags non-whitelisted untranslated ASCII/English entries in zh while allowing whitelisted unit templates", () => {
    const zh = new Map<string, string>([
      ["web.note.types.base", "Base"],
      ["web.audio.metadataRate", "{value} Hz"],
      ["web.audio.customRate", "{value} kHz"],
      ["web.note.types.doc", "块文档"],
      ["shared.join.labeled", "{label}：{text}"],
    ]);
    const en = new Map<string, string>([
      ["web.note.types.base", "Base"],
      ["web.audio.metadataRate", "{value} Hz"],
      ["web.audio.customRate", "{value} kHz"],
      ["web.note.types.doc", "Block Doc"],
      ["shared.join.labeled", "{label}: {text}"],
    ]);

    expect(ZH_ASCII_ALLOWLIST.has("web.audio.metadataRate")).toBe(true);
    const problems = zhUntranslatedProblems(zh, en);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("web.note.types.base");
    expect(problems[1]).toContain("web.audio.customRate");
  });

  it("asserts web.note.types.* parity against all 4 NOTE_TYPES", () => {
    expect(NOTE_TYPES).toHaveLength(4);
    const partial = new Map<string, string>([
      ["web.note.types.doc", "块文档"],
      ["web.note.types.base", "多维库"],
    ]);
    const problems = noteTypeParityProblems("zh", partial);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes("web.note.types.media"))).toBe(true);
  });
});
