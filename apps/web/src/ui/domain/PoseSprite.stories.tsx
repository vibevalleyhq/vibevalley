import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { SpeciesValues, type Species } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import type { Pose } from "./cast";
import { PoseSprite } from "./PoseSprite";

const viewStyles = stylex.create({
  poseSpriteStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "1.5rem",
  },
  poseSpriteStoriesDiv2: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  poseSpriteStoriesSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-muted)",
  },
});

const poses: Pose[] = ["idle", "walk", "think", "work", "cheer", "worry"];

export default stories({
  title: "组件/工作台/PoseSprite",
  stories: {
    Poses: story({
      args: { species: "bear", height: 64 },
      controls: { species: { kind: "choice", options: SpeciesValues }, height: { kind: "number", min: 32, max: 128, step: 16 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.poseSpriteStoriesDiv)}>
          <For each={poses}>
            {(pose) => (
              <div {...stylex.attrs(viewStyles.poseSpriteStoriesDiv2)}>
                <PoseSprite cast={{ species: a.species as Species, outfit: "farmer" }} pose={pose} height={a.height} />
                <span {...stylex.attrs(viewStyles.poseSpriteStoriesSpan)}>{pose}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
  },
});
