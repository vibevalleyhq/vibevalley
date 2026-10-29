// What the blocks tests write artifacts with.

import type { Block, TextSpan } from "@vibevalley/protocol";

export const span = (t: string): TextSpan => ({ t, marks: {} });
export const bold = (t: string): TextSpan => ({ t, marks: { bold: true } });
export const para = (id: string, key: string, text: string): Block => ({
  id,
  artifactId: "d",
  orderKey: key,
  type: "paragraph",
  attrs: {},
  text: [span(text)],
  rev: 1,
  updatedBy: "owner",
  updated: 0,
});

/** Every kind of block, and inline marks, as the export writes them. */
export const sample =
  "# 周报：VibeValley 🌾\n" +
  "\n" +
  "这周把**块编辑器**的第一步做完了，_顺利_ 😀。见 [设计](https://example.com/a_b) 和 `artifact.submit`，~~不用 CRDT~~。\n" +
  "\n" +
  "## 做了什么\n" +
  "\n" +
  "- 按块存\n" +
  "  - 子项：中文、emoji 👍🏽\n" +
  "- [x] 合并段落\n" +
  "- [ ] 三方合并\n" +
  "1. 第一\n" +
  "2. 第二\n" +
  "\n" +
  "> 引用一句\n" +
  "> 第二行\n" +
  "\n" +
  "```go\n" +
  "func main() {\n" +
  '\tfmt.Println("**不是粗体**")\n' +
  "}\n" +
  "```\n" +
  "\n" +
  "---\n" +
  "\n" +
  '![农场](https://example.com/farm.png "640x480")\n' +
  "\n" +
  "<!-- issue:0192f -->\n" +
  "\n" +
  "<!-- memory:m1 --> 记住：测试用 `make check`\n" +
  "\n" +
  "\\# 不是标题，\\*也不是\\* 列表 \\\\ 反斜杠\n" +
  "\n" +
  "### 结尾\n";
