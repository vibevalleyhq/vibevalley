import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { Markdown } from "./Markdown";

const viewStyles = stylex.create({
  dynamicWidth: (width: number) => ({ maxWidth: width }),
  markdownStoriesDiv: {
    width: "100%",
    maxWidth: "var(--container-2xl)",
  },
});

const sample = [
  "## 修好登录",
  "",
  "改了 `session.ts`，**过期**的会话现在回到登录页。见 #12，和 [设计稿](https://example.com)。",
  "",
  "- [x] 复现",
  "- [ ] 补测试",
  "",
  "> 旧的 cookie 不再读。",
  "",
  "| 文件 | 改了 |",
  "|---|---|",
  "| session.ts | 12 行 |",
  "",
  "```ts",
  "export const expired = (s: Session, now: number) => s.until < now;",
  "```",
].join("\n");

const diagram = ["```mermaid", "flowchart LR", "  用户 --> 助手 --> 帮工", "  帮工 -->|交活| 用户", "```"].join("\n");

const long = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`), "```"].join("\n");

export default stories({
  title: "组件/工作台/Markdown",
  stories: {
    Composition: story({
      args: { width: 240 },
      render: (a, set) => (
        <div data-testid="markdown-composition">
          <Markdown text="A paragraph with [a link](https://example.com)." styles={viewStyles.dynamicWidth(a.width)} />
          <button type="button" data-testid="resize-markdown" onClick={() => set({ width: 320 })}>
            Resize
          </button>
        </div>
      ),
    }),
    Message: story({
      note: "代码上色、可复制、长的折起；链接只放安全的；#12 去工单。",
      args: { text: sample, mentions: true },
      controls: { text: { kind: "text", long: true } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.markdownStoriesDiv)}>
          <Markdown text={a.text} mentions={a.mentions} />
        </div>
      ),
    }),
    Diagram: story({
      note: "Mermaid 由 Pele 画，里面没有会跑的东西。",
      args: { text: diagram },
      controls: { text: { kind: "text", long: true } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.markdownStoriesDiv)}>
          <Markdown text={a.text} />
        </div>
      ),
    }),
    "Folded code": story({
      render: () => (
        <div {...stylex.attrs(viewStyles.markdownStoriesDiv)}>
          <Markdown text={long} />
        </div>
      ),
    }),
  },
});
