import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "../shapes";

export const AgentProblemLevel: Codec<T.AgentProblemLevel> = Schema.Literals(T.AgentIssueLevelValues);

export const AgentProblem: Codec<T.AgentProblem> = Schema.Struct({
  field: Schema.String,
  level: AgentProblemLevel,
  text: Schema.String,
});

export const PersonaMode: Codec<T.PersonaMode> = Schema.Literals(T.PersonaModeValues);

export const MCPServerStdio: Codec<T.MCPServerStdio> = Schema.Struct({
  type: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.mutable(Schema.Array(Schema.String)),
  env: Schema.Record(Schema.String, Schema.String),
});

export const MCPServerHTTP: Codec<T.MCPServerHTTP> = Schema.Struct({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
});

export const MCPServer: Codec<T.MCPServer> = Schema.Union([MCPServerStdio, MCPServerHTTP]);

export const Species: Codec<T.Species> = Schema.Literals(T.SpeciesValues);

export const Outfit: Codec<T.Outfit> = Schema.Literals(T.OutfitValues);

export const Build: Codec<T.Build> = Schema.Literals(T.BuildValues);

export const Head: Codec<T.Head> = Schema.Literals(T.HeadValues);

export const Look: Codec<T.Look> = Schema.Struct({
  species: Schema.NullOr(Species),
  outfit: Schema.NullOr(Outfit),
  orchestrator: Schema.NullOr(Schema.Literals(T.OrchestratorLookValues)),
  build: Build,
  head: Head,
  body: Schema.String,
  trim: Schema.String,
  hat: Schema.String,
  eye: Schema.String,
});

export const AgentFrom: Codec<T.AgentFrom> = Schema.Struct({ template: Schema.String, version: Schema.Finite });

export const Agent: Codec<T.Agent> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.Literals(T.AgentRoleValues),
  duty: Schema.String,
  enabled: Schema.Boolean,
  runtime: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  persona: Schema.String,
  personaMode: PersonaMode,
  skills: Schema.mutable(Schema.Array(Schema.String)),
  mcpServers: Schema.mutable(Schema.Array(MCPServer)),
  disallowedTools: Schema.mutable(Schema.Array(Schema.String)),
  env: Schema.Record(Schema.String, Schema.String),
  workdir: Schema.String,
  worktree: Schema.Boolean,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  look: Look,
  from: Schema.optionalKey(AgentFrom),
});

export const AgentTemplate: Codec<T.AgentTemplate> = Schema.Struct({
  id: Schema.String,
  version: Schema.Finite,
  role: Schema.Literals(T.AgentRoleValues),
  name: Schema.String,
  duty: Schema.String,
  tags: Schema.mutable(Schema.Array(Schema.String)),
  runtime: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  personaMode: PersonaMode,
  worktree: Schema.Boolean,
  look: Look,
  persona: Schema.String,
  source: Schema.Literals(T.AgentTemplateSourceValues),
  skills: Schema.mutable(Schema.Array(Schema.String)),
  installed: Schema.mutable(Schema.Array(Schema.String)),
});

export const AgentValidateRequest: Codec<T.AgentValidateRequest> = Schema.Struct({
  agents: Schema.mutable(Schema.Array(Agent)),
});

export const AgentValidation: Codec<T.AgentValidation> = Schema.Struct({
  id: Schema.String,
  problems: Schema.mutable(Schema.Array(AgentProblem)),
});

export const Skill: Codec<T.Skill> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  builtIn: Schema.optionalKey(Schema.Boolean),
});
