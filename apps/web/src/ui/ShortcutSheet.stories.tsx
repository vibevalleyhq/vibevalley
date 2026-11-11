import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Kbd, Shortcuts } from "./ShortcutSheet";

const viewStyles = stylex.create({
  shortcutSheetStoriesDiv: {
    width: "30rem",
  },
  shortcutSheetStoriesDiv2: {
    display: "flex",
    gap: "0.25rem",
  },
});

export default stories({
  title: "组件/工作台/ShortcutSheet",
  stories: {
    List: story({
      note: "页面上按 ? 打开的那张单子里的内容。",
      render: () => (
        <div {...stylex.attrs(viewStyles.shortcutSheetStoriesDiv)}>
          <Shortcuts />
        </div>
      ),
    }),
    Keys: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.shortcutSheetStoriesDiv2)}>
          <For each={["⌘", "K", "?", "Esc", "↵"]}>{(k) => <Kbd>{k}</Kbd>}</For>
        </div>
      ),
    }),
  },
});
