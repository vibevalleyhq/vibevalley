import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

const AgentProblemLevel = z.enum(T.AgentIssueLevelValues) satisfies Codec<T.AgentProblemLevel>;

const AgentProblem = z.object({
  field: z.string(),
  level: AgentProblemLevel,
  text: z.string(),
}) satisfies Codec<T.AgentProblem>;

export const PersonaMode = z.enum(T.PersonaModeValues) satisfies Codec<T.PersonaMode>;

const MCPServerStdio = z.object({
  type: z.literal("stdio"),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
}) satisfies Codec<T.MCPServerStdio>;

const MCPServerHTTP = z.object({
  type: z.literal("http"),
  name: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
}) satisfies Codec<T.MCPServerHTTP>;

const MCPServer = z.discriminatedUnion("type", [MCPServerStdio, MCPServerHTTP]) satisfies Codec<T.MCPServer>;

export const Species = z.enum(T.SpeciesValues) satisfies Codec<T.Species>;

export const Outfit = z.enum(T.OutfitValues) satisfies Codec<T.Outfit>;

export const Build = z.enum(T.BuildValues) satisfies Codec<T.Build>;

export const Head = z.enum(T.HeadValues) satisfies Codec<T.Head>;

export const Look = z.object({
  species: Species.nullable(),
  outfit: Outfit.nullable(),
  orchestrator: z.enum(T.OrchestratorLookValues).nullable(),
  build: Build,
  head: Head,
  body: z.string(),
  trim: z.string(),
  hat: z.string(),
  eye: z.string(),
}) satisfies Codec<T.Look>;

const AgentFrom = z.object({ template: z.string(), version: z.number() }) satisfies Codec<T.AgentFrom>;

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(T.AgentRoleValues),
  duty: z.string(),
  enabled: z.boolean(),
  runtime: z.string(),
  model: z.string(),
  effort: z.string(),
  persona: z.string(),
  personaMode: PersonaMode,
  skills: z.array(z.string()),
  mcpServers: z.array(MCPServer),
  disallowedTools: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  workdir: z.string(),
  worktree: z.boolean(),
  tags: z.array(z.string()),
  look: Look,
  from: z.exactOptional(AgentFrom),
}) satisfies Codec<T.Agent>;

export const AgentTemplate = z.object({
  id: z.string(),
  version: z.number(),
  role: z.enum(T.AgentRoleValues),
  name: z.string(),
  duty: z.string(),
  tags: z.array(z.string()),
  runtime: z.string(),
  model: z.string(),
  effort: z.string(),
  personaMode: PersonaMode,
  worktree: z.boolean(),
  look: Look,
  persona: z.string(),
  source: z.enum(T.AgentTemplateSourceValues),
  skills: z.array(z.string()),
  installed: z.array(z.string()),
}) satisfies Codec<T.AgentTemplate>;

export const AgentValidateRequest = z.object({
  agents: z.array(Agent),
}) satisfies Codec<T.AgentValidateRequest>;

export const AgentValidation = z.object({
  id: z.string(),
  problems: z.array(AgentProblem),
}) satisfies Codec<T.AgentValidation>;

export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  builtIn: z.exactOptional(z.boolean()),
}) satisfies Codec<T.Skill>;
