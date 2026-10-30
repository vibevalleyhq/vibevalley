import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { addedComments, addedLines, batchSize, type Comment, commentsIn, type Message, readVerdicts, review, rubric } from "./comment-review";

const diff = `diff --git a/apps/a.ts b/apps/a.ts
--- a/apps/a.ts
+++ b/apps/a.ts
@@ -3,0 +4,2 @@ export const x = 1;
+// one
+// two
@@ -10 +12 @@
-old
+new
@@ -20,2 +22,0 @@
-gone
-gone
diff --git a/apps/b.ts b/apps/b.ts
new file mode 100644
--- /dev/null
+++ b/apps/b.ts
@@ -0,0 +1,3 @@
+a
+b
+c
`;

test("the added lines are read from each hunk's new side; a hunk that only removes adds none", () => {
  const added = addedLines(diff);
  expect([...added.get("apps/a.ts")!]).toEqual([4, 5, 12]);
  expect([...added.get("apps/b.ts")!]).toEqual([1, 2, 3]);
});

const src = `// one
// two
const s = "// not a comment";

/** A block. */
const x = 1; // trailing
// @ts-expect-error: a tool's
const y: number = "y";
/* a */ // b
`;

test("a run of // on the lines one after another is one comment; a block, a directive and a string are not part of it", () => {
  const comments = commentsIn("a.ts", src);
  expect(comments.map((c) => [c.line, c.endLine, c.text])).toEqual([
    [1, 2, "// one\n// two"],
    [5, 5, "/** A block. */"],
    [6, 6, "// trailing"],
    [9, 9, "/* a */"],
    [9, 9, "// b"],
  ]);
  expect(comments[1]!.context.split("\n")).toContain("> /** A block. */");
});

test("a comment is reviewed when any of its lines is added", () => {
  const comments = commentsIn("a.ts", src);
  expect(addedComments(comments, new Set([2])).map((c) => c.line)).toEqual([1]);
  expect(addedComments(comments, new Set([3, 4, 7, 8]))).toEqual([]);
});

test("the rule is docs/style/code.md's 注释 section, both tables and nothing after it", () => {
  const rule = rubric(readFileSync(resolve(import.meta.dirname, "../docs/style/code.md"), "utf8"));
  expect(rule.startsWith("## 注释")).toBe(true);
  expect(rule).toContain("### 建议写");
  expect(rule).toContain("### 不建议写");
  expect(rule).not.toMatch(/\n## /u);
  expect(() => rubric("# 代码风格\n\n## 格式\n")).toThrow("no 注释 section");
});

const comment = (line: number): Comment => ({ file: "a.ts", line, endLine: line, text: "// c", context: "> // c" });

test("a keep reports nothing; a delete or rewrite reports its rule and reason, and only a rewrite its new text", () => {
  const answer = JSON.stringify({
    verdicts: [
      { id: 0, verdict: "keep", rule: "", reason: "says the unit", rewrite: "" },
      { id: 1, verdict: "delete", rule: "照着名字或代码再说一遍", reason: "repeats the name", rewrite: "// ignored" },
      { id: 2, verdict: "rewrite", rule: "推理过程、行为说明", reason: "keeps the why", rewrite: "// Why." },
    ],
  });
  expect(readVerdicts("```json\n" + answer + "\n```", [comment(1), comment(2), comment(3)])).toEqual([
    { comment: comment(2), verdict: "delete", rule: "照着名字或代码再说一遍", reason: "repeats the name", rewrite: "" },
    { comment: comment(3), verdict: "rewrite", rule: "推理过程、行为说明", reason: "keeps the why", rewrite: "// Why." },
  ]);
});

test("an answer missing a comment, or with a verdict outside the three, is an error and never a keep", () => {
  expect(() => readVerdicts(JSON.stringify({ verdicts: [{ id: 0, verdict: "keep" }] }), [comment(1), comment(2)])).toThrow("no verdict for a.ts:2");
  expect(() => readVerdicts(JSON.stringify({ verdicts: [{ id: 0, verdict: "maybe" }] }), [comment(1)])).toThrow('verdict "maybe"');
  expect(() => readVerdicts(JSON.stringify({ answer: [] }), [comment(1)])).toThrow("no verdicts array");
  expect(() => readVerdicts("I think they are fine", [comment(1)])).toThrow();
});

test("comments go to the model in batches, each answered by its own ids, the findings in the comments' order", async () => {
  const comments = Array.from({ length: batchSize * 2 + 5 }, (_, i) => comment(i + 1));
  const asked: Message[][] = [];
  const findings = await review("## 注释", comments, async (messages) => {
    asked.push(messages);
    const ids = [...messages[1]!.content.matchAll(/^## (\d+) a\.ts:(\d+)$/gmu)];
    return JSON.stringify({
      verdicts: ids.map(([, id, line]) => ({ id: Number(id), verdict: Number(line) % 10 === 0 ? "delete" : "keep", rule: "r", reason: "x" })),
    });
  });
  expect(asked).toHaveLength(3);
  expect(asked[0]![0]!.content).toContain("## 注释");
  expect(findings.map((f) => f.comment.line)).toEqual([10, 20, 30, 40]);
});
