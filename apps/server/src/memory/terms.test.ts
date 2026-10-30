import { expect, test } from "vite-plus/test";
import { goldenCases } from "@/testing/golden.ts";
import { termsList, termsOf } from "./terms.ts";

test("the words are gse's, as recorded", () => {
  const failed: string[] = [];
  for (const c of goldenCases("memory")) {
    const cue = (c.in as { cue: { text: string } }).cue;
    const got = [...termsOf(cue.text)].toSorted();
    const want = (c.out as { terms: string[] }).terms;
    if (JSON.stringify(got) !== JSON.stringify(want) && failed.length < 10)
      failed.push(`line ${c.line} ${JSON.stringify(cue.text)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  expect(failed).toEqual([]);
});

test("words, and code whole", () => {
  for (const [text, want] of [
    ["这个项目测试用 pnpm test", ["项目", "测试", "pnpm", "test"]],
    ["迁移文件在 db/migrations", ["迁移", "文件", "db/migrations"]],
    ["登录态统一走 refreshSession()", ["登录", "统一", "refreshsession"]],
    ["表名单数", ["名单", "单数"]],
    ["v1.2.3 发布", ["发布", "v1.2.3"]],
  ] as const) {
    const got = termsList(text);
    for (const w of want) expect(got, text).toContain(w);
  }
});
