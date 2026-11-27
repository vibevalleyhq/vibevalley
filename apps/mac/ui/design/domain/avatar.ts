import type { Agent, Look } from "@vibevalley/protocol";

import { ROLE_AVATARS } from "../art";

const WORKER_DEFAULT_AVATARS = ROLE_AVATARS.filter((id) => id !== "avatar-orchestrator");

function fnv1aHash(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Deterministic Papertrails role avatar for a worker that has not chosen one explicitly. */
export function defaultWorkerAvatar(agentId: string, name?: string): string {
  const seed = agentId.trim() || name?.trim() || "worker";
  return WORKER_DEFAULT_AVATARS[fnv1aHash(seed) % WORKER_DEFAULT_AVATARS.length] ?? "avatar-fullstack";
}

/** Assigns distinct Papertrails avatars across a worker list by hashing each worker and probing round-robin on collisions. */
export function assignWorkerAvatars(agents: readonly Pick<Agent, "id" | "name" | "look">[]): ReadonlyMap<string, string> {
  const used = new Set<string>();
  for (const agent of agents) {
    if (agent.look.avatar) used.add(agent.look.avatar);
  }
  const assigned = new Map<string, string>();
  const poolSize = WORKER_DEFAULT_AVATARS.length;
  for (const agent of agents) {
    if (agent.look.avatar) continue;
    const seed = agent.id.trim() || agent.name.trim() || "worker";
    const start = fnv1aHash(seed) % poolSize;
    let picked = WORKER_DEFAULT_AVATARS[start] ?? "avatar-fullstack";
    for (let step = 0; step < poolSize; step++) {
      const candidate = WORKER_DEFAULT_AVATARS[(start + step) % poolSize];
      if (candidate && !used.has(candidate)) {
        picked = candidate;
        used.add(candidate);
        break;
      }
    }
    assigned.set(agent.id, picked);
  }
  return assigned;
}

/** Preserves an explicit avatar choice, otherwise fills a deterministic Papertrails role avatar. */
export function withDefaultWorkerAvatar(agent: Pick<Agent, "id" | "name" | "look">, assignedAvatar?: string): Look {
  if (agent.look.avatar) return agent.look;
  return { ...agent.look, avatar: assignedAvatar ?? defaultWorkerAvatar(agent.id, agent.name) };
}
