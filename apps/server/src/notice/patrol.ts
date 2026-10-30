import { type InboxKind, type WorkspaceState } from "@vibevalley/protocol";

import { inboxEntries } from "./inbox.ts";
import { patrolAgo } from "./prompts.ts";

/** In ms. Kinds not here the orchestrator does not hear of from the patrol: a failed run reaches it as it happens, a task
 * waiting is the person's to look at. */
const patrolGrace: Partial<Record<InboxKind, number>> = {
  mention: 15 * 60_000,
  // A helper's question holds its work up: as soon as a mention.
  ask: 15 * 60_000,
  interrupted: 30 * 60_000,
  quiet: 20 * 60_000,
  review: 2 * 60 * 60_000,
  conflict: 2 * 60 * 60_000,
  "task-failed": 30 * 60_000,
};

const reportAgainMs = 4 * 60 * 60_000;

export interface PatrolNote {
  readonly key: string;
  readonly channel?: string;
  readonly text: string;
}

export interface PatrolMemory {
  readonly firstSeen: Record<string, number>;
  readonly reported: Record<string, number>;
}

export const emptyPatrol = (): PatrolMemory => ({ firstSeen: {}, reported: {} });

/** Things no longer hanging are forgotten, so if they come back they are new. */
export function patrolStep(state: WorkspaceState, now: number, memory: PatrolMemory): [PatrolNote[], PatrolMemory] {
  const next = emptyPatrol();
  const report: PatrolNote[] = [];
  for (const e of inboxEntries(state)) {
    const grace = patrolGrace[e.item.kind];
    if (grace === undefined) continue;
    const key = e.item.id;
    const seen = memory.firstSeen[key] ?? now;
    next.firstSeen[key] = seen;
    const since = e.since ?? seen;
    const last = memory.reported[key];
    if (last !== undefined) next.reported[key] = last;
    if (now - since < grace) continue;
    if (last !== undefined && now - last < reportAgainMs) continue;
    next.reported[key] = now;
    report.push({ key, ...(e.channel !== undefined ? { channel: e.channel } : {}), text: e.brief.replace("{ago}", patrolAgo(now - since)) });
  }
  return [report, next];
}
