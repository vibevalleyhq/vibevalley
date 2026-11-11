import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { RuntimeIcon } from "./RuntimeIcon";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  runtimeIconStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
  },
});

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh", "unknown"];

export default stories({
  title: "组件/像素/RuntimeIcon",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Runtimes: story({
      args: { size: 24 },
      controls: { size: { kind: "number", min: 12, max: 48, step: 4 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.runtimeIconStoriesDiv)}>
          <For each={runtimes}>{(r) => <RuntimeIcon runtime={r} size={a.size} />}</For>
        </div>
      ),
    }),
  },
});
