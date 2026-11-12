import type { JSX } from "@solidjs/web";

import { stories, story } from "@vibevalley/stories";

import { PxMarkdown, PxReadText } from "./PxMarkdown";

const viewStyles = {
  indented: (marginLeft: number): JSX.CSSProperties => ({ "--indent": `${marginLeft}px` }),
};

const sample = [
  "## 交活了",
  "",
  "改了 `session.ts`，过期的会话回到登录页。",
  "",
  "- [x] 复现",
  "- [ ] 补测试",
  "",
  "```ts",
  "export const expired = (s: Session, now: number) => s.until < now;",
  "```",
].join("\n");

export default stories({
  title: "组件/像素/PxMarkdown",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-(length:--text-xs) text-bark-900",
  stories: {
    Composition: story({
      args: { reading: false, indent: 4, maxLines: 2 },
      render: (a) => (
        <div data-testid="pixel-rich-composition" class="w-96" style={viewStyles.indented(a.indent)}>
          <PxMarkdown
            text={"# 交活了\n\n@w3 看 [说明](https://example.com)。\n\n> 引用\n\n`code` 和 **强调**。\n\n---"}
            mentions
            reading={a.reading}
            class="ml-(--indent)"
          />
          <PxReadText text={"一行\n二行\n三行\n四行"} maxLines={a.maxLines} class="ml-(--indent)" />
        </div>
      ),
    }),
    Report: story({
      args: { text: sample, reading: false },
      controls: { text: { kind: "text", long: true } },
      render: (a) => (
        <div class="w-96">
          <PxMarkdown text={a.text} reading={a.reading} />
        </div>
      ),
    }),
    "Read text": story({
      args: { maxLines: 2 },
      render: (a) => (
        <div class="w-64">
          <PxReadText text="一段很长的说明，只给看前几行，后面的折起来；点开工单才看得到全部。再多写一点让它够长。" maxLines={a.maxLines} />
        </div>
      ),
    }),
  },
});
