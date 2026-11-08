import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { DashedLine, PxCard, PxFrame, PxWindow } from "./base";
import { PxButton } from "./button";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  baseStoriesDiv: {
    padding: "calc(var(--spacing) * 3)",
  },
});

export default stories({
  title: "组件/像素/base",
  themes: ["light"],
  frame: storyFrame.pixel,
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
    Frame: story({
      args: { paper: "bg-cream-50" },
      controls: { paper: { kind: "choice", options: ["bg-cream-50", "bg-cream-100", "bg-lcd-paper"] } },
      render: (a) => (
        <PxFrame paper={a.paper} class="w-56">
          <div {...stylex.attrs(viewStyles.baseStoriesDiv)}>框里的东西离边 2 像素</div>
        </PxFrame>
      ),
    }),
  },
});
