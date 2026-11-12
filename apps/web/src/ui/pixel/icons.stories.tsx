import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import { SessionActionValues, type Phase, type SessionAction } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { ActionGlyph, Marked, PhaseGlyph, SpriteIcon } from "./icons";

const viewStyles = {
  composed: (offset: number): JSX.CSSProperties => ({ "margin-left": `${offset}px` }),
};

const sprites = ["icon-seeds", "icon-shovel", "icon-water", "icon-bell", "icon-coin", "icon-shed", "icon-tree", "icon-bug", "icon-trophy", "icon-wrench"];
const working = (action: SessionAction) => ({ _tag: "working", since: 0, doing: { action } }) as Phase;
const phases: [string, Phase][] = [
  ["starting", working("none")],
  ["working", working("edit_file")],
  ["done", { _tag: "done" }],
  ["failed", { _tag: "failed" }],
  ["resting", { _tag: "resting" }],
];

export default stories({
  title: "组件/像素/icons",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-(length:--text-xs) text-bark-900",
  stories: {
    Composition: story({
      args: { size: 24, offset: 12 },
      controls: {
        size: { kind: "number", min: 12, max: 48, step: 4 },
        offset: { kind: "number", min: 0, max: 32, step: 4 },
      },
      render: (a) => (
        <SpriteIcon
          name="button-next"
          size={a.size}
          label="Composed sprite"
          class="[rotate:90deg]"
          style={{ ...viewStyles.composed(a.offset), "margin-top": "8px" }}
        />
      ),
    }),
    Sprites: story({
      args: { size: 24 },
      controls: { size: { kind: "number", min: 12, max: 48, step: 4 } },
      render: (a) => (
        <div class="flex flex-wrap gap-3">
          <For each={sprites}>{(name) => <SpriteIcon name={name} size={a.size} label={name} />}</For>
        </div>
      ),
    }),
    Actions: story({
      note: "帮工这会儿在做的事。",
      render: () => (
        <div class="flex flex-wrap gap-4">
          <For each={SessionActionValues}>
            {(action) => (
              <span class="flex items-center gap-1.5">
                <ActionGlyph action={action} />
                <span class="font-mono text-2xs">{action}</span>
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Phases: story({
      render: () => (
        <div class="flex flex-wrap gap-4">
          <For each={phases}>
            {([name, phase]) => (
              <span class="flex items-center gap-1.5">
                <PhaseGlyph phase={phase} />
                <span class="font-mono text-2xs">{name}</span>
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Marked: story({
      render: () => (
        <div class="w-64">
          <Marked mark="icon-bell">助手说：两块地熟了，可以去看改动了。</Marked>
        </div>
      ),
    }),
  },
});
