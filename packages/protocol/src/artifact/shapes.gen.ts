// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ArtifactId, IssueId, SessionId, SuggestionId } from "../common/shapes.gen";

export const ArtifactTypeValues = ["docs", "outline", "slides", "dashboard", "motion", "whiteboard", "design", "design-system", "sheet", "prototype", "diagram", "storyboard"] as const;
export type ArtifactType = (typeof ArtifactTypeValues)[number];

export const ArtifactFileEncodingValues = ["utf8", "base64"] as const;
export type ArtifactFileEncoding = (typeof ArtifactFileEncodingValues)[number];

export type ArtifactCard = { id: ArtifactId, title: string, artifactType: ArtifactType, version: number, note: string, };

export type ArtifactVersion = { version: number, size: number, note: string, by: string, byName: string, at: number, channel: string, number?: number, };

export type ArtifactSaid = { channel: string, number: number, };

export type Artifact = { id: ArtifactId, title: string, artifactType: ArtifactType,
/**
 * True on the standing default design-system artifact consumed when creating visual artifacts.
 */
isDefault: boolean, channel?: string, said?: ArtifactSaid, issue?: IssueId, by: string, byName: string,
/**
 * Latest immutable snapshot version number; 0 before any snapshot is cut.
 */
version: number,
/**
 * Monotonic collaborative revision sequence bumped on each committed file or collab write.
 */
seq: number,
/**
 * Immutable version snapshots, oldest first.
 */
versions: Array<ArtifactVersion>, at: number, updated: number, };

export type ArtifactFileMeta = {
/**
 * Relative path inside `<storage>/artifact/<id>/` (e.g. `manifest.json`, `structure/index.md`, `asset/hero.png`).
 */
path: string, mime: string, size: number,
/**
 * Content SHA-256 hex digest.
 */
hash: string, updatedAt: number, };

export type ArtifactFileListRequest = { id: ArtifactId,
/**
 * Optional relative prefix filter (e.g. `structure/` or `asset/`).
 */
prefix?: string, };

export type ArtifactFileListResult = { artifactId: ArtifactId, seq: number, files: Array<ArtifactFileMeta>, };

export type ArtifactFileGetRequest = { id: ArtifactId, path: string,
/**
 * Optional immutable version snapshot number to read from.
 */
version?: number, };

export type ArtifactFileContent = { artifactId: ArtifactId, path: string, mime: string, encoding: ArtifactFileEncoding, content: string, size: number, hash: string, updatedAt: number, };

export type ArtifactFileWriteItem = {
/**
 * Relative path inside `<storage>/artifact/<id>/` (`manifest.json`, `structure/*`, or `asset/*`).
 */
path: string,
/**
 * UTF-8 text (default) or base64-encoded bytes when `encoding` is `base64`.
 */
content: string, encoding?: ArtifactFileEncoding, mime?: string,
/**
 * Optional optimistic concurrency guard matching the file's current SHA-256 hash (`""` requires absent).
 */
expectedHash?: string, };

export type ArtifactFileWriteRequest = { id: ArtifactId, files: Array<ArtifactFileWriteItem>,
/**
 * Attribution origin (e.g. `user`, `session:<id>:turn:<n>`); defaults to caller identity.
 */
origin?: string, summary?: string, announce?: boolean, };

export type ArtifactFileWriteResult = { artifactId: ArtifactId, seq: number, files: Array<ArtifactFileMeta>, frontiers?: string,
/**
 * Populated when an agent write to a human-owned region was diverted into review suggestions.
 */
suggestions?: Array<Suggestion>, };

export type ArtifactFileDeleteRequest = { id: ArtifactId,
/**
 * Relative path under `structure/` or `asset/` to delete.
 */
path: string, origin?: string, summary?: string, };

export type ArtifactFileDeleteResult = { artifactId: ArtifactId, seq: number, path: string, frontiers?: string, };

export type ArtifactTypeInfo = { type: ArtifactType, title: string, summary: string,
/**
 * Canonical primary entry path inside `<storage>/artifact/<id>/`.
 */
entry: string, references: Array<string>, defaultArtifactId: ArtifactId | null, };

export type ArtifactTypeReadRequest = { type: ArtifactType, reference?: string, };

export type ArtifactTypeGuide = { type: ArtifactType, title: string, reference: string | null, content: string, references: Array<string>, defaultArtifactId: ArtifactId | null, defaultArtifactTitle: string | null, };

export type ArtifactViewContext = { artifactId: ArtifactId, artifactType: ArtifactType, title: string, seq?: number, version?: number,
/**
 * Active relative file path inside `structure/` (e.g. `structure/slides/s02-kpi.json`).
 */
activePath?: string, slideId?: string, slideIndex?: number, time?: number, activeArtboard?: string, activeDataset?: string, activeTab?: string, selectedIds?: Array<string>, summary?: string, };

/**
 * Creates a new directory-backed artifact seeded with starter files for `artifact_type`
 * (and optional initial `content` for the entry file or additional `files`).
 */
export type ArtifactRequest = { title: string, artifactType: ArtifactType, content?: string, files?: Array<ArtifactFileWriteItem>, isDefault?: boolean, announce?: boolean, note?: string, channel?: string, issue?: string, };

export type ArtifactVersionRequest = { id: ArtifactId,
/**
 * Optional updated primary entry content before snapshotting; omit to snapshot current directory state.
 */
content?: string, note?: string, };

export type ArtifactUpdateRequest = { id: ArtifactId, title?: string, isDefault?: boolean, };

export type ArtifactListRequest = { channel?: string, issue?: string, artifactType?: ArtifactType, };

export type ArtifactReadRequest = { id: ArtifactId, version?: number, };

export type ArtifactContent = { version: number, content: string, };

export type ArtifactGetInput = { id: ArtifactId, };

export type ArtifactDeleteInput = { id: ArtifactId, };

/**
 * Reset is sent when the subscriber falls too far behind the collaborative change log.
 */
export type ArtifactEvent = { "_tag": "Files", seq: number, files: Array<ArtifactFileMeta>, deleted: Array<string>, origin?: string, frontiers?: string, } | { "_tag": "Reset", };

export const SuggestionStatusValues = ["open", "accepted", "rejected"] as const;
export type SuggestionStatus = (typeof SuggestionStatusValues)[number];

/**
 * Proposed edit to a file or structured target inside an artifact directory.
 * At least one of `content`, `patch`, or `delete` must be set.
 */
export type SuggestionChange = { content?: string, patch?: string, target?: string, delete?: boolean, summary?: string, };

export type Suggestion = { id: SuggestionId, artifactId: ArtifactId,
/**
 * Relative path inside `<storage>/artifact/<id>/` (e.g. `structure/index.md`).
 */
path: string, author: string, baseRev: number, baseHash?: string, change: SuggestionChange, status: SuggestionStatus, createdAt: number, resolvedAt?: number, resolvedBy?: string, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export type SuggestionCreate = { path: string, baseRev: number, baseHash?: string, change: SuggestionChange, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export const SuggestionEventKindValues = ["Suggestions"] as const;
export type SuggestionEventKind = (typeof SuggestionEventKindValues)[number];

export type SuggestionEvent = { _tag: SuggestionEventKind, suggestions: Array<Suggestion>, };

export type ArtifactSuggestionListInput = { id: ArtifactId, };

export type ArtifactSuggestionCreateInput = { id: ArtifactId, path: string, baseRev: number, baseHash?: string, change: SuggestionChange, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export type ArtifactSuggestionAcceptInput = { id: ArtifactId, suggestion: SuggestionId, };

export const ArtifactPresenceKindValues = ["cursor", "selection", "highlight", "viewport"] as const;
export type ArtifactPresenceKind = (typeof ArtifactPresenceKindValues)[number];

export type ViewportRect = { x: number, y: number, w: number, h: number, zoom?: number, };

export type ArtifactPresence = {
/**
 * Stable actor/peer identifier (e.g. "user" or "session:<id>").
 */
id: string, name: string, color?: string, kind: ArtifactPresenceKind, x?: number, y?: number, w?: number, h?: number, status?: string,
/**
 * Focused element, outline node, slide, or cell identifier inside `path`.
 */
nodeId?: string, offset?: number, endOffset?: number, selector?: string, path?: string, viewport?: ViewportRect, sessionId?: SessionId, updatedAt: number, };

/**
 * Omit `presence` to remove the caller's live presence entry immediately.
 */
export type ArtifactPresenceUpdateRequest = { id: ArtifactId, presence?: ArtifactPresence, peerId?: string, };

export type ArtifactPresenceFollowRequest = { id: ArtifactId, };

export type ArtifactPresenceEvent = { "_tag": "Snapshot", peers: Array<ArtifactPresence>, } | { "_tag": "Upsert", peer: ArtifactPresence, } | { "_tag": "Remove", peerId: string, };

export type ArtifactHistoryEntry = {
/**
 * Encoded Loro frontiers identifying this commit snapshot.
 */
frontiers: string, author: string, agent?: string, sessionId?: SessionId, turn?: number, origin: string, summary?: string, at: number, };

export type ArtifactHistoryListRequest = { id: ArtifactId, limit?: number, };

export type ArtifactHistoryPreviewRequest = { id: ArtifactId, frontiers: string, };

export type ArtifactHistoryPreviewResult = { artifactId: ArtifactId, artifactType: ArtifactType, frontiers: string, entry?: ArtifactHistoryEntry, files: Array<ArtifactFileContent>, };

export type ArtifactHistoryRestoreRequest = { id: ArtifactId, frontiers: string, note?: string, };

export type ArtifactHistoryForkRequest = { id: ArtifactId, frontiers: string, title?: string, channel?: string, };

export type ArtifactHistoryUndoOriginRequest = { id: ArtifactId, origin: string, };

export type ArtifactHistoryCompactRequest = { id: ArtifactId, };
