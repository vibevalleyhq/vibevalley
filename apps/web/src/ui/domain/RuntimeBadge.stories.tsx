import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { RuntimeBadge } from "./RuntimeBadge";

const viewStyles = stylex.create({
  runtimeBadgeStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "1rem",
  },
  runtimeBadgeStoriesSpan: {
    position: "relative",
    display: "inline-block",
    width: "2.5rem",
    height: "2.5rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
  },
});

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh", "unknown"];

export default stories({
  title: "组件/工作台/RuntimeBadge",
  stories: {
    Runtimes: story({
      note: "叠在头像右下角；没有 logo 的是扳手。",
      args: { size: 16 },
      controls: { size: { kind: "number", min: 10, max: 24 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.runtimeBadgeStoriesDiv)}>
          <For each={runtimes}>
            {(runtime) => (
              <span {...stylex.attrs(viewStyles.runtimeBadgeStoriesSpan)}>
                <RuntimeBadge runtime={runtime} size={a.size} />
              </span>
            )}
          </For>
        </div>
      ),
    }),
  },
});
