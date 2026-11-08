import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { icons, type IconName } from "./icons";
import { Dot, type DotTone, Tag, type TagTone } from "./Tag";

const viewStyles = stylex.create({
  tagStoriesDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  tagStoriesDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
  },
  tagStoriesSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--wb-muted)",
  },
});

const dotTones: DotTone[] = ["leaf", "wheat", "berry", "water", "idle", "faint", "muted"];

export default stories({
  title: "组件/工作台/Tag",
  stories: {
    States: story({
      args: { tone: "ok", icon: "check", label: "完成" },
      grid: { rows: ["tone", ["ok", "bad", "wait"]], cols: ["icon", ["", "check"]] },
      render: (a) => <Tag label={a.label} tone={a.tone as TagTone} icon={(a.icon || undefined) as IconName | undefined} />,
    }),
    Playground: story({
      args: { label: "完成", tone: "ok", icon: "check" },
      controls: { tone: { kind: "choice", options: ["ok", "bad", "wait"] }, icon: { kind: "choice", options: ["", ...Object.keys(icons)] } },
      render: (a) => <Tag label={a.label} tone={a.tone as TagTone} icon={(a.icon || undefined) as IconName | undefined} />,
    }),
    Tones: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.tagStoriesDiv)}>
          <Tag tone="ok" icon="check" label="完成" />
          <Tag tone="bad" icon="close" label="失败" />
          <Tag tone="wait" icon="send" label="已发" />
        </div>
      ),
    }),
    "Dot tones": story({
      args: { ring: false, size: 8 },
      controls: { size: { kind: "number", min: 4, max: 16 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.tagStoriesDiv2)}>
          <For each={dotTones}>
            {(tone) => (
              <span {...stylex.attrs(viewStyles.tagStoriesSpan)}>
                <Dot tone={tone} ring={a.ring} size={a.size} />
                {tone}
              </span>
            )}
          </For>
        </div>
      ),
    }),
  },
});
