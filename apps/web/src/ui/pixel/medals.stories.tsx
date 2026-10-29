import { For, Show } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { useAtlas } from "./atlas";
import { EarnedMedal } from "./medals";

const achievements = ["first_try", "harvests", "night_owl", "steady", "thrifty", "weekend", "full_house", "untangle"];

export default stories({
  title: "组件/像素/medals",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Medals: story({
      args: { tier: 1, size: 48 },
      controls: { tier: { kind: "number", min: 1, max: 3 }, size: { kind: "number", min: 24, max: 96, step: 8 } },
      render: (a) => {
        const atlas = useAtlas();
        return (
          <Show when={atlas()}>
            {(atlas) => (
              <div class="flex flex-wrap gap-3">
                <For each={achievements}>{(id) => <EarnedMedal atlas={atlas()} achievement={id} tier={a.tier} size={a.size} />}</For>
              </div>
            )}
          </Show>
        );
      },
    }),
  },
});
