import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { PxButton } from "./button";
import { storyFrame } from "./story.stylex";
import { ToastStore, ToastViewport } from "./ToastViewport";

const viewStyles = stylex.create({
  toastViewportStoriesDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
  },
});

// Made outside the render: a store's atom says its first value at once, a write a component may not make.
const store = new ToastStore();

export default stories({
  title: "组件/像素/ToastViewport",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Toasts: story({
      fill: true,
      note: "顶上居中一叠，指针放上去就停住，往右或往下拖开关掉。",
      render: () => (
        <div {...stylex.attrs(viewStyles.toastViewportStoriesDiv)}>
          <PxButton onClick={() => store.add({ title: "两块地熟了", description: "去看改动" })}>说一句</PxButton>
          <PxButton tone="danger" onClick={() => store.add({ type: "error", title: "没连上服务端" })}>
            说一句坏的
          </PxButton>
          <PxButton onClick={() => store.add({ type: "achievement", title: "第一次就过", timeout: 0 })}>成就</PxButton>
          <ToastViewport store={store} top={48} />
        </div>
      ),
    }),
  },
});
