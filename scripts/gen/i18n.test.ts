import { describe, expect, it } from "vite-plus/test";

import { glyphLabelProblems } from "./i18n.ts";

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
