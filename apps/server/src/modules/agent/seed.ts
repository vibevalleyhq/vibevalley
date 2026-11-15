import type * as T from "@vibevalley/protocol";

/** An agent as the farm keeps it, with defaults: a test says only the parts it is about. */
export const sampleAgent = (a: Partial<T.Agent> & Pick<T.Agent, "id">): T.Agent => ({
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
  look: { species: null, outfit: null, orchestrator: null, build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
  ...a,
});
