// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { AgentRole } from "../common/shapes.gen";

export const AgentProblemLevelValues = ["error", "warn"] as const;
export type AgentProblemLevel = (typeof AgentProblemLevelValues)[number];

export type AgentProblem = { field: string, level: AgentProblemLevel, text: string, };

export const PersonaModeValues = ["append", "replace", "prompt"] as const;
export type PersonaMode = (typeof PersonaModeValues)[number];

export type MCPServerStdio = { "type": "stdio", name: string, command: string, args: Array<string>, env: { [key in string]: string }, };

export type MCPServerHTTP = { "type": "http", name: string, url: string, headers: { [key in string]: string }, };

/**
 * Told apart by `type`.
 */
export type MCPServer = MCPServerStdio | MCPServerHTTP;

export const SpeciesValues = ["bear", "rabbit", "fox", "cat", "owl", "hedgehog", "raccoon"] as const;
export type Species = (typeof SpeciesValues)[number];

export const OutfitValues = ["farmer", "gardener", "rain", "winter"] as const;
export type Outfit = (typeof OutfitValues)[number];

export const BuildValues = ["biped", "treads", "wheel", "hopper", "hover"] as const;
export type Build = (typeof BuildValues)[number];

export const HeadValues = ["rounded", "terminal", "dome", "orb", "saucer"] as const;
export type Head = (typeof HeadValues)[number];

export const OrchestratorLookValues = ["farmer", "foreman", "auntie", "grandpa", "gardener", "robot"] as const;
export type OrchestratorLook = (typeof OrchestratorLookValues)[number];

export type Look = { 
/**
 * null until the server fills it from the id.
 */
species: Species | null, outfit: Outfit | null, 
/**
 * An orchestrator's look: its sprites are manager-<look>, the plain one is farmer. A helper has null.
 */
orchestrator: OrchestratorLook | null, build: Build, head: Head, body: string, trim: string, hat: string, eye: string, };

/**
 * Where a profile came from: a template's id and the version it had then.
 */
export type AgentFrom = { template: string, version: number, };

export type Agent = { id: string, name: string, role: AgentRole, 
/**
 * What it does, in a sentence (duty): orchestrators read it to pick who takes a job.
 */
duty: string, enabled: boolean, runtime: string, model: string, effort: string, persona: string, personaMode: PersonaMode, skills: Array<string>, mcpServers: Array<MCPServer>, disallowedTools: Array<string>, env: { [key in string]: string }, workdir: string, worktree: boolean, tags: Array<string>, look: Look, 
/**
 * The template it was installed from, at that template's version; none for one made by hand.
 */
from?: AgentFrom, };

export const AgentTemplateSourceValues = ["builtIn", "added"] as const;
export type AgentTemplateSource = (typeof AgentTemplateSourceValues)[number];

/**
 * A recipe for a profile (agent.json and persona.md in a folder), in the farm's language: installing it makes a profile.
 */
export type AgentTemplate = { id: string, 
/**
 * Raised when the template changes: a profile installed at a lower one has an update.
 */
version: number, role: AgentRole, name: string, duty: string, tags: Array<string>, 
/**
 * The runtime it is written for.
 */
runtime: string, model: string, effort: string, personaMode: PersonaMode, worktree: boolean, look: Look, persona: string, source: AgentTemplateSource, 
/**
 * The built-in skills a profile installed from it has ticked, by id.
 */
skills: Array<string>, 
/**
 * The profiles installed from it, by id.
 */
installed: Array<string>, };

export type AgentValidateRequest = { agents: Array<Agent>, };

export type AgentValidation = { id: string, problems: Array<AgentProblem>, };

export type Skill = { id: string, name: string, description: string, body: string, 
/**
 * Shipped with VibeValley (apps/server/src/agent/skills): read-only, changed only by updating VibeValley.
 */
builtIn?: boolean, };

export type AgentDeleteInput = { id: string, };

export type AgentTemplateInstallInput = { id: string, };

export type AgentTemplateUpdateInput = { agent: string, };

export type AgentTemplateAddInput = { path: string, };

export type SkillDeleteInput = { id: string, };
