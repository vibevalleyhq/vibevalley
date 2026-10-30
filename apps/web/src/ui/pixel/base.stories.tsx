import { stories, story } from "@vibevalley/stories";

import { DashedLine, PxCard, PxWindow } from "./base";
import { PxButton } from "./button";

export default stories({
  title: "组件/像素/base",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Card: story({
      args: { title: "今天的收成", aside: "3 块地" },
      render: (a) => (
        <PxCard title={a.title} aside={a.aside} class="w-72">
          <p>两块熟了，一块缺肥。</p>
          <DashedLine class="my-3" />
          <PxButton tone="primary" onClick={() => undefined}>
            去看看
          </PxButton>
        </PxCard>
      ),
    }),
    Window: story({
      args: { border: true },
      render: (a) => (
        <PxWindow border={a.border} class="w-64 p-4">
          窗子里的纸
        </PxWindow>
      ),
    }),
  },
});
