import { For, Show } from "solid-js";
import { SpeciesValues } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { useAtlas } from "./atlas";
import { CardColors, badgeColors } from "./card";
import { AnimalFace, PixelCard } from "./PixelCard";

export default stories({
  title: "组件/像素/PixelCard",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Sign: story({
      note: "地头的木牌：一行行的字、图标和进度条。",
      args: { title: "修好登录", fill: 0.6 },
      controls: { fill: { kind: "number", min: 0, max: 1, step: 0.1 } },
      render: (a) => {
        const atlas = useAtlas();
        return (
          <Show when={atlas()}>
            {(atlas) => (
              <PixelCard
                rows={[
                  [
                    { kind: "icon", sprite: atlas().get("icon-seeds"), px: 16 },
                    { kind: "words", text: a.title },
                  ],
                  [
                    { kind: "faces", looks: ["bear-farmer", "fox-farmer"], atlas: atlas() },
                    { kind: "words", text: "2 个帮工", color: CardColors.muted },
                  ],
                  [{ kind: "bar", fill: a.fill, w: 80, h: 6 }],
                ]}
              />
            )}
          </Show>
        );
      },
    }),
    Badges: story({
      render: () => (
        <div class="flex gap-3">
          <For each={Object.entries(badgeColors)}>
            {([tone, [paper, ink]]) => <PixelCard paper={paper} ink={ink} rows={[[{ kind: "words", text: tone, color: ink }]]} />}
          </For>
        </div>
      ),
    }),
    Faces: story({
      args: { size: 32 },
      controls: { size: { kind: "number", min: 16, max: 64, step: 8 } },
      render: (a) => {
        const atlas = useAtlas();
        return (
          <Show when={atlas()}>
            {(atlas) => (
              <div class="flex gap-2">
                <For each={SpeciesValues}>{(s) => <AnimalFace atlas={atlas()} look={`${s}-farmer`} size={a.size} />}</For>
              </div>
            )}
          </Show>
        );
      },
    }),
  },
});
