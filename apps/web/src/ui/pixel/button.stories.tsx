import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { PxButton, type PxSize, type PxTone } from "./button";

const tones: PxTone[] = ["plain", "primary", "accent", "danger"];

export default stories({
  title: "pixel/PxButton",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
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
