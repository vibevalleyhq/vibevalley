import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { PxButton, type PxSize, type PxTone } from "./button";

const viewStyles = {
  composed: (width: number): JSX.CSSProperties => ({ width: `${width}px` }),
};

const tones: PxTone[] = ["plain", "primary", "accent", "danger"];

export default stories({
  title: "组件/像素/PxButton",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-(length:--text-xs) text-bark-900",
  stories: {
    Composition: story({
      args: { width: 160 },
      controls: { width: { kind: "number", min: 120, max: 280, step: 40 } },
      render: (a, set) => (
        <PxButton
          data-testid="pixel-button-composition"
          class="ml-3"
          style={{ ...viewStyles.composed(a.width), "margin-top": "8px" }}
          onClick={() => set({ width: a.width === 160 ? 240 : 160 })}
        >
          Resize
        </PxButton>
      ),
    }),
    States: story({
      args: { label: "派活", tone: "primary", disabled: false },
      grid: { rows: ["tone", tones], cols: "pseudo" },
      render: (a) => (
        <PxButton tone={a.tone as PxTone} disabled={a.disabled} onClick={() => undefined}>
          {a.label}
        </PxButton>
      ),
    }),
    Playground: story({
      args: { label: "派活", tone: "primary", size: "md", icon: "", disabled: false },
      controls: {
        tone: { kind: "choice", options: tones },
        size: { kind: "choice", options: ["md", "sm"] },
        icon: { kind: "choice", options: ["", "icon-seeds", "icon-shovel", "icon-bell", "icon-water"] },
      },
      render: (a) => (
        <PxButton tone={a.tone as PxTone} size={a.size as PxSize} icon={a.icon || undefined} disabled={a.disabled} onClick={() => undefined}>
          {a.label}
        </PxButton>
      ),
    }),
    Tones: story({
      render: () => (
        <div class="flex flex-wrap items-center gap-2">
          <For each={tones}>
            {(tone) => (
              <PxButton tone={tone} onClick={() => undefined}>
                {tone}
              </PxButton>
            )}
          </For>
          <PxButton size="icon" icon="icon-bell" label="通知" onClick={() => undefined} />
        </div>
      ),
    }),
  },
});
