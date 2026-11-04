// The shapes of profiles, their looks and templates, skills (docs/subsystems/agent.md).

export const AgentIssueLevelValues = ["error", "warn"] as const;
export type AgentProblemLevel = (typeof AgentIssueLevelValues)[number];

export interface AgentProblem {
  field: string;
  level: AgentProblemLevel;
  text: string;
}

export interface AgentValidateRequest {
  agents: Agent[];
}

export interface AgentValidation {
  id: string;
  problems: AgentProblem[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** What a profile is: an orchestrator (管家) stays and coordinates; a worker (帮工) is sent on an issue. */
export const AgentRoleValues = ["orchestrator", "worker"] as const;
export type AgentRole = (typeof AgentRoleValues)[number];

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  /** What it does, in a sentence (职责): orchestrators read it to pick who takes a job. */
  duty: string;
  enabled: boolean;
  runtime: string;
  model: string;
  effort: string;
  persona: string;
  personaMode: PersonaMode;
  skills: string[];
  mcpServers: MCPServer[];
  disallowedTools: string[];
  env: Record<string, string>;
  workdir: string;
  worktree: boolean;
  tags: string[];
  look: Look;
  /** The template it was installed from, at that template's version; none for one made by hand. */
  from?: AgentFrom;
}

/** Where a profile came from: a template's id and the version it had then. */
export interface AgentFrom {
  template: string;
  version: number;
}

/** Built in: shipped with VibeValley; added: copied in from a folder on this machine. */
export const AgentTemplateSourceValues = ["builtIn", "added"] as const;
export type AgentTemplateSource = (typeof AgentTemplateSourceValues)[number];

/** A recipe for a profile (agent.json and persona.md in a folder), in the farm's language: installing it makes a profile.
 * An orchestrator's always runs on VibeValley's own agent. */
export interface AgentTemplate {
  id: string;
  /** Raised when the template changes: a profile installed at a lower one has an update. */
  version: number;
  role: AgentRole;
  name: string;
  duty: string;
  tags: string[];
  /** The runtime it is written for. */
  runtime: string;
  model: string;
  effort: string;
  personaMode: PersonaMode;
  worktree: boolean;
  look: Look;
  persona: string;
  source: AgentTemplateSource;
  /** The profiles installed from it, by id. */
  installed: string[];
}

export interface Look {
  species?: Species;
  outfit?: Outfit;
  /** An orchestrator's look: its sprites are manager-<look>, the plain one is farmer. A helper has none. */
  orchestrator?: OrchestratorLook;
  build: Build;
  head: Head;
  body: string;
  trim: string;
  hat: string;
  eye: string;
}

export const HeadValues = ["rounded", "terminal", "dome", "orb", "saucer"] as const;
export type Head = (typeof HeadValues)[number];

export const BuildValues = ["biped", "treads", "wheel", "hopper", "hover"] as const;
export type Build = (typeof BuildValues)[number];

export const OrchestratorLookValues = ["farmer", "foreman", "auntie", "grandpa", "gardener", "robot"] as const;
export type OrchestratorLook = (typeof OrchestratorLookValues)[number];

export const OutfitValues = ["farmer", "gardener", "rain", "winter"] as const;
export type Outfit = (typeof OutfitValues)[number];

export const SpeciesValues = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"] as const;
export type Species = (typeof SpeciesValues)[number];

export const PersonaModeValues = ["append", "replace", "prompt"] as const;
export type PersonaMode = (typeof PersonaModeValues)[number];

/** Told apart by `type`. */
export type MCPServer = MCPServerStdio | MCPServerHTTP;

export interface MCPServerStdio {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MCPServerHTTP {
  type: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
}
