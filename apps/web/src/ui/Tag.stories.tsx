import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { icons, type IconName } from "./icons";
import { Dot, type DotTone, Tag, type TagTone } from "./Tag";

const viewStyles = {
  dotPlacement: (offset: number): JSX.CSSProperties => ({ "--offset": `${offset}px` }),
};

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
        <div class="flex gap-2">
          <Tag tone="ok" icon="check" label="完成" />
          <Tag tone="bad" icon="close" label="失败" />
          <Tag tone="wait" icon="send" label="已发" />
        </div>
      ),
    }),
    "Dot placement": story({
      args: { ring: true, size: 9, offset: 12 },
      controls: { size: { kind: "number", min: 4, max: 16 }, offset: { kind: "number", min: 0, max: 32 } },
      render: (a) => (
        <div class="contents" style={viewStyles.dotPlacement(a.offset)}>
          <Dot tone="leaf" ring={a.ring} size={a.size} class="ml-(--offset)" />
        </div>
      ),
    }),
    "Dot tones": story({
      args: { ring: false, size: 8 },
      controls: { size: { kind: "number", min: 4, max: 16 } },
      render: (a) => (
        <div class="flex flex-wrap items-center gap-4">
          <For each={dotTones}>
            {(tone) => (
              <span class="flex items-center gap-1.5 font-mono text-2xs text-muted">
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
