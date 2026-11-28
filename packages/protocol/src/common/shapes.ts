export * from "./shapes.gen";

import type { ParticipantId } from "./shapes.gen";

/** The built-in orchestrator's profile id. */
export const defaultOrchestrator = "orchestrator";

/** The runtime of VibeValley's own agent: the only one an orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

/** Default local interactive user participant id (`user:self`). */
export const localUserParticipant: ParticipantId = "user:self";

export const agentParticipant = (profile: string): ParticipantId => `agent:${profile}`;

export const isHumanParticipant = (id: string): boolean => id.startsWith("user:");
export const participantRawId = (id: string): string => {
  const idx = id.indexOf(":");
  return idx >= 0 ? id.slice(idx + 1) : id;
};

/** Who the everyone mention is. */
export const everyone = "everyone";

/** Times are Unix milliseconds. */
export const dayMs = 86400000;
