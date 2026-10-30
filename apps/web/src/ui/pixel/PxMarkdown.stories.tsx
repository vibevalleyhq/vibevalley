import { stories, story } from "@vibevalley/stories";

import { PxMarkdown, PxReadText } from "./PxMarkdown";

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
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
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
