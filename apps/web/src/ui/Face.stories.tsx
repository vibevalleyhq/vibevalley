import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { type Look, type Species, SpeciesValues } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { AgentFace, OrchestratorFace, UserFace } from "./Face";

const viewStyles = stylex.create({
  faceStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 3)",
  },
  faceStoriesDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
});

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh"];
const lookOf = (species: Species): Look => ({
  species,
  outfit: "farmer",
  orchestrator: null,
  build: "biped",
  head: "rounded",
  body: "",
  trim: "",
  hat: "",
  eye: "",
});
const looks = ["farmer", "auntie", "foreman", "gardener", "grandpa", "robot"];

export default stories({
  title: "组件/工作台/Face",
  stories: {
    Agents: story({
      args: { size: 32, muted: false, runtime: "claude" },
      controls: { size: { kind: "number", min: 16, max: 96, step: 8 }, runtime: { kind: "choice", options: ["", ...runtimes] } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.faceStoriesDiv)}>
          <For each={SpeciesValues}>
            {(species) => <AgentFace agentId={species} look={lookOf(species)} size={a.size} muted={a.muted} runtime={a.runtime || undefined} />}
          </For>
        </div>
      ),
    }),
    "User and orchestrator": story({
      args: { size: 32 },
      controls: { size: { kind: "number", min: 16, max: 96, step: 8 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.faceStoriesDiv2)}>
          <UserFace size={a.size} />
          <For each={looks}>{(look) => <OrchestratorFace size={a.size} look={look} />}</For>
        </div>
      ),
    }),
  },
});
