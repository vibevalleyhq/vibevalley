import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { RuntimeIcon } from "./RuntimeIcon";

const viewStyles = stylex.create({
  runtimeIconStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 3)",
  },
});

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh", "unknown"];

export default stories({
  title: "组件/像素/RuntimeIcon",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
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
