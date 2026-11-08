import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { useAtlas } from "./atlas";
import { CrossMark, EarnedMedal, TickMark } from "./glyphs";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  glyphsStoriesDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
  },
  glyphsStoriesDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 3)",
  },
});

const achievements = ["first_try", "harvests", "night_owl", "steady", "thrifty", "weekend", "full_house", "untangle"];

export default stories({
  title: "组件/像素/glyphs",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Marks: story({
      args: { size: 16 },
      controls: { size: { kind: "number", min: 8, max: 48, step: 4 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.glyphsStoriesDiv)}>
          <TickMark size={a.size} color="var(--color-leaf-600)" label="对" />
          <CrossMark size={a.size} color="var(--color-berry-500)" label="错" />
        </div>
      ),
    }),
    Medals: story({
      args: { tier: 1, size: 48 },
      controls: { tier: { kind: "number", min: 1, max: 3 }, size: { kind: "number", min: 24, max: 96, step: 8 } },
      render: (a) => {
        const atlas = useAtlas();
        return (
          <Show when={atlas()}>
            {(atlas) => (
              <div {...stylex.attrs(viewStyles.glyphsStoriesDiv2)}>
                <For each={achievements}>{(id) => <EarnedMedal atlas={atlas()} achievement={id} tier={a.tier} size={a.size} />}</For>
              </div>
            )}
          </Show>
        );
      },
    }),
  },
});
