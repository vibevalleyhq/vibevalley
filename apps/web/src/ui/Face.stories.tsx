import { For } from "solid-js";
import { type Look, type Species, SpeciesValues } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { AgentFace, OrchestratorFace, OwnerFace } from "./Face";

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh"];
const lookOf = (species: Species): Look => ({ species, outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" });
const looks = ["farmer", "auntie", "foreman", "gardener", "grandpa", "robot"];

export default stories({
  title: "ui/Face",
  stories: {
    Agents: story({
      args: { size: 32, muted: false, runtime: "claude" },
      controls: { size: { kind: "number", min: 16, max: 96, step: 8 }, runtime: { kind: "choice", options: ["", ...runtimes] } },
      render: (a) => (
        <div class="flex flex-wrap gap-3">
          <For each={SpeciesValues}>
            {(species) => <AgentFace agentId={species} look={lookOf(species)} size={a.size} muted={a.muted} runtime={a.runtime || undefined} />}
          </For>
        </div>
      ),
    }),
    "Owner and orchestrator": story({
      args: { size: 32 },
      controls: { size: { kind: "number", min: 16, max: 96, step: 8 } },
      render: (a) => (
        <div class="flex items-center gap-3">
          <OwnerFace size={a.size} />
          <For each={looks}>{(look) => <OrchestratorFace size={a.size} look={look} />}</For>
        </div>
      ),
    }),
  },
});
