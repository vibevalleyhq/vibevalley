// A whole profile for a test: a test says only what it is about, the rest is a profile as the farm keeps one.

import type { Agent } from "@vibevalley/protocol";

export const sampleAgent = (a: Partial<Agent> & Pick<Agent, "id">): Agent => ({
  name: a.id,
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: false,
  tags: [],
  look: { build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
  ...a,
});
