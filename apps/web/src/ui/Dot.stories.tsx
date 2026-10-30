import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Dot, type DotTone } from "./Dot";

const tones: DotTone[] = ["leaf", "wheat", "berry", "water", "idle", "faint", "muted"];

export default stories({
  title: "组件/工作台/Dot",
  stories: {
    Tones: story({
      args: { ring: false, size: 8 },
      controls: { size: { kind: "number", min: 4, max: 16 } },
      render: (a) => (
        <div class="flex flex-wrap items-center gap-4">
          <For each={tones}>
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
