import { For } from "solid-js";

import { SpeciesValues, type Species } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import type { Pose } from "./cast";
import { PoseSprite } from "./PoseSprite";

const poses: Pose[] = ["idle", "walk", "think", "work", "cheer", "worry"];

export default stories({
  title: "组件/工作台/PoseSprite",
  stories: {
    Poses: story({
      args: { species: "bear", height: 64 },
      controls: { species: { kind: "choice", options: SpeciesValues }, height: { kind: "number", min: 32, max: 128, step: 16 } },
      render: (a) => (
        <div class="flex flex-wrap items-end gap-6">
          <For each={poses}>
            {(pose) => (
              <div class="flex flex-col items-center gap-1">
                <PoseSprite cast={{ species: a.species as Species, outfit: "farmer" }} pose={pose} height={a.height} />
                <span class="font-mono text-2xs text-muted">{pose}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
  },
});
