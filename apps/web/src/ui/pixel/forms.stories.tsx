import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { PxChipsInput } from "./forms";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  formsStoriesDiv: {
    width: "20rem",
  },
});

export default stories({
  title: "组件/像素/forms",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Chips: story({
      args: { words: "frontend,urgent", disabled: false },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.formsStoriesDiv)}>
          <PxChipsInput
            label="标签"
            placeholder="加一个"
            value={a.words ? a.words.split(",") : []}
            disabled={a.disabled}
            onChange={(v) => set({ words: v.join(",") })}
          />
        </div>
      ),
    }),
  },
});
