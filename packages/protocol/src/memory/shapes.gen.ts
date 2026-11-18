// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ActorKind, SessionId } from "../common/shapes.gen";
import type { MemorySourceInfo } from "../setting/shapes.gen";

export type RecallPreview = { lines: Array<string>, chars: number, limit: number, };

export const MemoryKindValues = ["note", "issue"] as const;
export type MemoryKind = (typeof MemoryKindValues)[number];

export type Memory = { id: string, agent: string, kind: MemoryKind, text: string, author: ActorKind, repo?: string, session?: SessionId, at: number, recalled: number, recalledAt?: number, fading: boolean, source?: string, };

export type MemoryRequest = { text: string, repo?: string, 
/**
 * The client's key for this request: the same key again within a while returns the first one's result and does it once (a retry after a lost reply).
 */
requestKey?: string, };

/**
 * "unknown": the source did not declare a scope.
 */
export type MemoryScope = { "kind": "global", } | { "kind": "repo", repo: string, } | { "kind": "unknown", };

/**
 * A memory a search found, with the source it came from and how well it matched.
 */
export type MemoryFound = { id: string, agent: string, kind: MemoryKind, text: string, author: ActorKind, repo?: string, session?: SessionId, at: number, recalled: number, recalledAt?: number, fading: boolean, source: string, score: number, scope: MemoryScope, };

export type MemorySearch = { found: Array<MemoryFound>, 
/**
 * The sources asked, as each says it covered the search.
 */
coverage: Array<string>, };

export type MemoryList = { memories: Array<Memory>, sources: Array<MemorySourceInfo>, };

export type MemoryListInput = { agent: string, };

export type MemoryRecallInput = { agent: string, repo?: string, text?: string, };

export type MemoryCreateInput = { agent: string, text: string, repo?: string, requestKey?: string, };

export type MemorySearchInput = { agent?: string, repo?: string, text?: string, };

export type MemoryDeleteInput = { agent: string, memory: string, };
