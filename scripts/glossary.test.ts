import { describe, expect, it } from "vite-plus/test";

import { avoidedWords, farmWords, missingNames, readGlossary, wordProblems } from "./glossary.ts";

const doc = `# 文档

## 用语

前言。

| 叫法 | English | 代码里 | 意思 | 不用 |
|---|---|---|---|---|
| 一件 | task | task（\`Task\`、\`TaskDraft\`） | 计划里的一件 | 步骤、step（指一件时）、node |
| 农机 | machine | runtime（\`RuntimeInfo\`） | 编码 agent 程序 | 引擎、runtime（中文界面） |
| 定时任务 | scheduled task | \`Cron\`、\`persona.md\` | 一种触发 | 定时、recurrence |
| 工单 | ticket | \`Config.WorkRoot\` | 一件活 | job、ticket |

### 农场的皮

| 农场里 | English | 实际是 | 代码里 |
|---|---|---|---|
| 收获、收成清单 | harvest | 完成 | \`Changes\` |
| 仓库 | warehouse | 合进去的 | \`delivered\` |
| 农场 | the farm | 这张皮 | |
`;

const glossary = readGlossary(doc);
const messages = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("the glossary's tables", () => {
  it("read every row of both, with its line", () => {
    expect(glossary.rows.map((r) => [r.term, r.line])).toEqual([
      ["一件", 9],
      ["农机", 10],
      ["定时任务", 11],
      ["工单", 12],
    ]);
    expect(glossary.farm.map((r) => r.farm)).toEqual(["收获、收成清单", "仓库", "农场"]);
  });

  it("fail loudly when a table is gone, rather than check nothing", () => {
    expect(() => readGlossary("## 用语\n\nno table\n")).toThrow(/叫法/u);
  });

  it("leave a word with a note to the reader, and keep the English column's words for the English page", () => {
    const { zh, en } = avoidedWords(glossary);
    expect(zh.map((a) => a.word)).toEqual(["步骤", "node", "引擎", "runtime", "定时", "recurrence", "job", "ticket"]);
    expect(en.map((a) => a.word)).toEqual(["node", "recurrence", "job"]);
  });

  it("take the farm's words but the skin's own name and the ones that are plain Chinese", () => {
    expect(farmWords(glossary).map((f) => f.word)).toEqual(["收获", "收成清单"]);
  });
});

describe("catalog words", () => {
  it("name the key, the word, and the word to say instead", () => {
    const problems = wordProblems(glossary, "zh", messages({ "web.issue.steps": "这个计划有 3 个步骤", "web.base.ok": "一件一件来" }));
    expect(problems).toEqual([expect.stringMatching(/^zh: web\.issue\.steps says 步骤, .*Fix: say 一件\. See docs\/README\.md/u)]);
  });

  it("do not read a word inside a word the glossary uses, a placeholder's name, or a skin's namespace", () => {
    expect(
      wordProblems(
        glossary,
        "zh",
        messages({ "web.cron.title": "定时任务", "web.runtime.of": "{runtime} 装好了", "web.farm.plot": "收获了，种子用完了", "web.issue.repo": "git 仓库" }),
      ),
    ).toEqual([]);
  });

  it("put the farm's words back in the skin", () => {
    expect(wordProblems(glossary, "zh", messages({ "web.issue.done": "收获了" }))).toEqual([expect.stringContaining("says 收获")]);
  });

  it("read English words whole, and let the English page say its own words", () => {
    expect(
      wordProblems(glossary, "en", messages({ "web.issue.a": "A job well done", "web.issue.b": "Jobs", "web.issue.c": "jobless ticket runtime" })),
    ).toEqual([expect.stringContaining("web.issue.a says job"), expect.stringContaining("web.issue.b says job")]);
  });
});

describe("code names", () => {
  it("report each name no code has, with its row", () => {
    const known = new Set(["Task", "TaskDraft", "RuntimeInfo", "Cron", "Changes", "delivered", "Config"]);
    const problems = missingNames(
      glossary,
      (n) => known.has(n),
      (f) => f === "persona.md",
    );
    expect(problems).toEqual([expect.stringMatching(/^docs\/README\.md:12: 工单 says the code calls it WorkRoot, which no code has\. Fix: /u)]);
  });

  it("look a file name up as a file", () => {
    expect(
      missingNames(
        glossary,
        () => true,
        () => false,
      ),
    ).toEqual([expect.stringContaining("persona.md")]);
  });
});
