import type { ActorKind, SessionId } from "../common/shapes";
import type { MemorySourceInfo } from "../setting/shapes";

/** The voice line's first words when the settings have none of their own; the voice samples say it. */

/** An agent's memories past this go, the longest unused first. */
export const memoryKeep = 300;

export interface RecallPreview {
  lines: string[];
  chars: number;
  limit: number;
}

export interface Memory {
  id: string;
  agent: string;
  kind: MemoryKind;
  text: string;
  author: ActorKind;
  repo?: string;
  session?: SessionId;
  at: number;
  recalled: number;
  recalledAt?: number;
  fading: boolean;
  source?: string;
}

export const MemoryKindValues = ["note", "issue"] as const;
export type MemoryKind = (typeof MemoryKindValues)[number];

export interface MemoryRequest {
  text: string;
  repo?: string;
  /** The client's key for this request: the same key again within a while returns the first one's result and does it once (a retry after a lost reply). */
  requestKey?: string;
}

/** "unknown": the source did not declare a scope. */
export type MemoryScope = { kind: "global" } | { kind: "repo"; repo: string } | { kind: "unknown" };

/** A memory a search found, with the source it came from and how well it matched. */
export interface MemoryFound extends Memory {
  source: string;
  score: number;
  scope: MemoryScope;
}

export interface MemorySearch {
  found: MemoryFound[];
  /** The sources asked, as each says it covered the search. */
  coverage: string[];
}

export interface MemoryList {
  memories: Memory[];
  sources: MemorySourceInfo[];
}
