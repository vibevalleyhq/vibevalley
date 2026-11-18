// VibeValley's Markdown stories (apps/web/src/ui/Markdown.stories.tsx), same samples.
import { Scroll, View } from "nsh";

import { memoryHistory, Router } from "../web/infra/router";
import { Markdown } from "../web/ui/Markdown";

export const sample = [
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

export const diagram = ["```mermaid", "flowchart LR", "  用户 --> 助手 --> 帮工", "  帮工 -->|交活| 用户", "```"].join("\n");

export const long = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`), "```"].join("\n");

export function MarkdownStory() {
  return (
    <Router history={memoryHistory("/")}>
      <Scroll class="flex-1" contentClass="gap-6 p-4">
        <View testID="md-message" class="w-full max-w-2xl">
          <Markdown text={sample} mentions />
        </View>
        <View testID="md-diagram" class="w-full max-w-2xl">
          <Markdown text={diagram} />
        </View>
        <View testID="md-long" class="w-full max-w-2xl">
          <Markdown text={long} size="sm" />
        </View>
      </Scroll>
    </Router>
  );
}
