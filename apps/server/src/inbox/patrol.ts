import { type InboxKind, type SpaceState } from "@vibevalley/protocol";

import { inboxEntries } from "./items.ts";
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
export function patrolStep(
  state: SpaceState,
  now: number,
  memory: PatrolMemory,
  userSeen: Readonly<Record<string, number>> = {},
): [PatrolNote[], PatrolMemory] {
  const next = emptyPatrol();
  const report: PatrolNote[] = [];
  for (const e of inboxEntries(state)) {
    const key = e.item.id;
    const seenAt = userSeen[key];
    const grace = seenAt === undefined ? patrolGrace[e.item.kind] : Math.max(patrolGrace[e.item.kind] ?? 0, 2 * 60 * 60_000);
    if (grace === undefined) continue;
    const seen = memory.firstSeen[key] ?? now;
    next.firstSeen[key] = seen;
    const since = Math.max(e.since ?? seen, seenAt ?? 0);
    const last = memory.reported[key];
    if (last !== undefined) next.reported[key] = last;
    if (now - since < grace) continue;
    if (last !== undefined && now - last < reportAgainMs) continue;
    next.reported[key] = now;
    report.push({ key, ...(e.channel !== undefined ? { channel: e.channel } : {}), text: e.brief.replace("{ago}", patrolAgo(now - since)) });
  }
  return [report, next];
}
