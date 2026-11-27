// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { IssueId, NoteId, SessionId, SuggestionId } from "../common/shapes.gen";

/**
 * Four consolidated note primitives (`doc`, `base`, `canvas`, `media`).
 */
export const NoteTypeValues = ["doc", "base", "canvas", "media"] as const;
/**
 * Four consolidated note primitives (`doc`, `base`, `canvas`, `media`).
 */
export type NoteType = (typeof NoteTypeValues)[number];

/**
 * Static directory layout specification for one of the 4 `NoteType` primitives.
 */
export type NoteTypeSpec = { noteType: NoteType,
/**
 * Kebab-case slug matching `crates/server/assets/note/types/<slug>/`.
 */
slug: string,
/**
 * Primary entry file path inside `<storage>/note/<id>/`.
 */
entryPath: string,
/**
 * MIME type of the primary entry file.
 */
entryMime: string,
/**
 * Relative directories created inside `<storage>/note/<id>/`.
 */
defaultDirs: Array<string>,
/**
 * Default suffix when exporting a single file for the user.
 */
exportSuffix: string, };

export const NOTE_TYPES = ["doc", "base", "canvas", "media"] as const;

export const NOTE_TYPE_SPECS: Readonly<Record<NoteType, NoteTypeSpec>> = {
  "doc": { noteType: "doc", slug: "doc", entryPath: "structure/doc.json", entryMime: "application/json", defaultDirs: ["structure","asset"], exportSuffix: ".md" },
  "base": { noteType: "base", slug: "base", entryPath: "structure/base.json", entryMime: "application/json", defaultDirs: ["structure","asset"], exportSuffix: ".base.json" },
  "canvas": { noteType: "canvas", slug: "canvas", entryPath: "structure/board.json", entryMime: "application/json", defaultDirs: ["structure","asset"], exportSuffix: ".canvas.json" },
  "media": { noteType: "media", slug: "media", entryPath: "structure/media.json", entryMime: "application/json", defaultDirs: ["structure","asset","asset/audio","asset/video","asset/image"], exportSuffix: ".media.json" },
};

export const NoteFileEncodingValues = ["utf8", "base64"] as const;
export type NoteFileEncoding = (typeof NoteFileEncodingValues)[number];

export type NoteCard = { id: NoteId, title: string, noteType: NoteType, version: number, note: string, };

export type NoteVersion = { version: number, size: number, note: string, by: string, byName: string, at: number, channel: string, number?: number, };

export type NoteSaid = { channel: string, number: number, };

export type NoteCover = {
/**
 * Absolute local filesystem path on the desktop host (for `file://` rendering).
 */
path: string,
/**
 * Authenticated HTTP URL path for remote clients (e.g. `/api/v1/note/<id>/cover?seq=<seq>`).
 */
url: string,
/**
 * Stored cover MIME type (`image/png`, `image/jpeg`, or `image/webp`).
 */
mime: string,
/**
 * Collaborative `seq` the cover was captured from.
 */
seq: number, width?: number, height?: number, updatedAt: number, };

export type NoteCoverSetRequest = { id: NoteId,
/**
 * Collaborative `seq` rendered when capturing this cover.
 */
seq: number,
/**
 * Image MIME type (`image/png`, `image/jpeg`, or `image/webp`).
 */
mime: string,
/**
 * Base64-encoded image bytes (max 2 MiB decoded).
 */
data: string, width?: number, height?: number, };

export type NotePreviewOutlineItem = { depth: number, text: string, kind: string, checked?: boolean, };

export type NotePreviewSwatch = { name: string, light: string, dark?: string, };

export type NotePreviewKpi = { label: string, value: string, };

export type NotePreviewMinimapShape = { x: number, y: number, w: number, h: number, kind: string, label?: string, };

/**
 * Lightweight structured content preview extracted from a note's `structure/` and `asset/` files.
 */
export type NotePreview = { "_tag": "doc", heading?: string, excerpt: string, blockCount: number, slideCount: number, outline: Array<NotePreviewOutlineItem>, } | { "_tag": "base", sheetName?: string, columns: Array<string>, rows: Array<Array<string>>, totalRows: number, totalCols: number, } | { "_tag": "canvas", shapes: Array<NotePreviewMinimapShape>, nodeCount: number, theme?: string, } | { "_tag": "media", mediaKind: string, caption?: string, durationSec?: number, frameAsset?: string, framePath?: string, };

export type Note = { id: NoteId, title: string, noteType: NoteType, parentId?: NoteId, sortOrder: number, channel?: string, said?: NoteSaid, issue?: IssueId, by: string, byName: string,
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
versions: Array<NoteVersion>, at: number, updated: number,
/**
 * Derived lightweight content preview extracted from `structure/` and `asset/`.
 */
preview?: NotePreview,
/**
 * Derived auto-captured cover image stored outside the note directory and CRDT.
 */
cover?: NoteCover, };

export type NoteFileMeta = {
/**
 * Relative path inside `<storage>/note/<id>/` (e.g. `manifest.json`, `structure/doc.json`, `asset/hero.png`).
 */
path: string, mime: string, size: number,
/**
 * Content SHA-256 hex digest.
 */
hash: string, updatedAt: number, };

export type NoteFileListRequest = { id: NoteId,
/**
 * Optional relative prefix filter (e.g. `structure/` or `asset/`).
 */
prefix?: string, };

export type NoteFileListResult = { noteId: NoteId, seq: number, files: Array<NoteFileMeta>, };

export type NoteFileGetRequest = { id: NoteId, path: string,
/**
 * Optional immutable version snapshot number to read from.
 */
version?: number, };

export type NoteFileContent = { noteId: NoteId, path: string, mime: string, encoding: NoteFileEncoding, content: string, size: number, hash: string, updatedAt: number, };

export type NoteFileWriteItem = {
/**
 * Relative path inside `<storage>/note/<id>/` (`manifest.json`, `structure/*`, or `asset/*`).
 */
path: string,
/**
 * UTF-8 text (default) or base64-encoded bytes when `encoding` is `base64`.
 */
content: string, encoding?: NoteFileEncoding, mime?: string,
/**
 * Optional optimistic concurrency guard matching the file's current SHA-256 hash (`""` requires absent).
 */
expectedHash?: string, };

export type NoteFileWriteRequest = { id: NoteId, files: Array<NoteFileWriteItem>,
/**
 * Attribution origin (e.g. `user`, `session:<id>:turn:<n>`); defaults to caller identity.
 */
origin?: string, summary?: string, announce?: boolean, };

export type NoteFileWriteResult = { noteId: NoteId, seq: number, files: Array<NoteFileMeta>, frontiers?: string,
/**
 * Populated when an agent write to a human-owned region was diverted into review suggestions.
 */
suggestions?: Array<Suggestion>, };

export type NoteFileDeleteRequest = { id: NoteId,
/**
 * Relative path under `structure/` or `asset/` to delete.
 */
path: string, origin?: string, summary?: string, };

export type NoteFileDeleteResult = { noteId: NoteId, seq: number, path: string, frontiers?: string, };

export type NoteTypeInfo = { type: NoteType, title: string, summary: string,
/**
 * Canonical primary entry path inside `<storage>/note/<id>/`.
 */
entry: string, references: Array<string>, };

export type NoteTypeReadRequest = { type: NoteType, reference?: string, };

export type NoteTypeGuide = { type: NoteType, title: string, reference: string | null, content: string, references: Array<string>, };

export type NoteViewContext = { noteId: NoteId, noteType: NoteType, title: string, seq?: number, version?: number,
/**
 * Active relative file path inside `structure/` (e.g. `structure/doc.json`).
 */
activePath?: string, slideId?: string, slideIndex?: number, time?: number, activeArtboard?: string, activeDataset?: string, activeTab?: string, selectedIds?: Array<string>, summary?: string, };

/**
 * Creates a new directory-backed note seeded with starter files for `note_type`
 * (and optional initial `content` for the entry file or additional `files`).
 */
export type NoteRequest = { title: string, noteType: NoteType, parentId?: NoteId, sortOrder?: number, content?: string, files?: Array<NoteFileWriteItem>, announce?: boolean, note?: string, channel?: string, issue?: string, };

export type NoteVersionRequest = { id: NoteId,
/**
 * Optional updated primary entry content before snapshotting; omit to snapshot current directory state.
 */
content?: string, note?: string, };

export type NoteUpdateRequest = { id: NoteId, title?: string,
/**
 * Parent note id; "" clears parent (moves to root).
 */
parentId?: string, sortOrder?: number,
/**
 * Linked issue id or number; "" clears the linked issue.
 */
issue?: string, };

export type NoteListRequest = { channel?: string, issue?: string, noteType?: NoteType, parentId?: NoteId, };

export type NoteReadRequest = { id: NoteId, version?: number, };

export type NoteContent = { version: number, content: string, };

export type NoteGetInput = { id: NoteId, };

export type NoteDeleteInput = { id: NoteId, };

export type NoteFollowPayload = { id: NoteId, after: number, };

/**
 * Reset is sent when the subscriber falls too far behind the collaborative change log.
 */
export type NoteEvent = { "_tag": "Files", seq: number, files: Array<NoteFileMeta>, deleted: Array<string>, origin?: string, frontiers?: string, } | { "_tag": "Reset", };

export const SuggestionStatusValues = ["open", "accepted", "rejected"] as const;
export type SuggestionStatus = (typeof SuggestionStatusValues)[number];

/**
 * Proposed edit to a file or structured target inside a note directory.
 * At least one of `content`, `patch`, or `delete` must be set.
 */
export type SuggestionChange = { content?: string, patch?: string, target?: string, delete?: boolean, summary?: string, };

export type Suggestion = { id: SuggestionId, noteId: NoteId,
/**
 * Relative path inside `<storage>/note/<id>/` (e.g. `structure/doc.json`).
 */
path: string, author: string, baseRev: number, baseHash?: string, change: SuggestionChange, status: SuggestionStatus, createdAt: number, resolvedAt?: number, resolvedBy?: string, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export type SuggestionCreate = { path: string, baseRev: number, baseHash?: string, change: SuggestionChange, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export const SuggestionEventKindValues = ["Suggestions"] as const;
export type SuggestionEventKind = (typeof SuggestionEventKindValues)[number];

export type SuggestionEvent = { _tag: SuggestionEventKind, suggestions: Array<Suggestion>, };

export type NoteSuggestionListInput = { id: NoteId, };

export type NoteSuggestionCreateInput = { id: NoteId, path: string, baseRev: number, baseHash?: string, change: SuggestionChange, cursorStart?: string, cursorEnd?: string, startOffset?: number, endOffset?: number, };

export type NoteSuggestionAcceptInput = { id: NoteId, suggestion: SuggestionId, };

export type NoteSuggestionFollowPayload = { id: NoteId, };

export const NotePresenceKindValues = ["cursor", "selection", "highlight", "viewport"] as const;
export type NotePresenceKind = (typeof NotePresenceKindValues)[number];

export type ViewportRect = { x: number, y: number, w: number, h: number, zoom?: number, };

export type NotePresence = {
/**
 * Stable actor/peer identifier (e.g. "user" or "session:<id>").
 */
id: string, name: string, color?: string, kind: NotePresenceKind, x?: number, y?: number, w?: number, h?: number, status?: string,
/**
 * Focused block, canvas node, or cell identifier inside `path`.
 */
nodeId?: string, offset?: number, endOffset?: number, selector?: string, path?: string, viewport?: ViewportRect, sessionId?: SessionId, updatedAt: number, };

/**
 * Omit `presence` to remove the caller's live presence entry immediately.
 */
export type NotePresenceUpdateRequest = { id: NoteId, presence?: NotePresence, peerId?: string, };

export type NotePresenceFollowRequest = { id: NoteId, };

export type NotePresenceEvent = { "_tag": "Snapshot", peers: Array<NotePresence>, } | { "_tag": "Upsert", peer: NotePresence, } | { "_tag": "Remove", peerId: string, };

export type NoteHistoryEntry = {
/**
 * Encoded Loro frontiers identifying this commit snapshot.
 */
frontiers: string, author: string, agent?: string, sessionId?: SessionId, turn?: number, origin: string, summary?: string, at: number, };

export type NoteHistoryListRequest = { id: NoteId, limit?: number, };

export type NoteHistoryPreviewRequest = { id: NoteId, frontiers: string, };

export type NoteHistoryPreviewResult = { noteId: NoteId, noteType: NoteType, frontiers: string, entry?: NoteHistoryEntry, files: Array<NoteFileContent>, };

export type NoteHistoryRestoreRequest = { id: NoteId, frontiers: string, note?: string, };

export type NoteHistoryForkRequest = { id: NoteId, frontiers: string, title?: string, channel?: string, };

export type NoteHistoryUndoOriginRequest = { id: NoteId, origin: string, };

export type NoteHistoryCompactRequest = { id: NoteId, };

export type NoteCollabExportRequest = { id: NoteId,
/**
 * Base64-encoded Loro `VersionVector` (`LoroDoc::version`); omit for full snapshot.
 */
versionVector?: string, };

export type NoteCollabExportResult = { noteId: NoteId, seq: number,
/**
 * Server's current Loro `VersionVector` encoded as base64.
 */
versionVector: string,
/**
 * Server's current Loro `Frontiers` encoded as base64.
 */
frontiers: string,
/**
 * True when `update` contains a full Loro snapshot rather than an incremental delta.
 */
snapshot: boolean,
/**
 * Base64-encoded Loro update or snapshot bytes compatible with `loro-crdt` WASM/JS.
 */
update: string, };

export type NoteCollabImportRequest = { id: NoteId,
/**
 * Base64-encoded Loro update or snapshot bytes compatible with `loro-crdt` WASM/JS.
 */
update: string,
/**
 * Optional client Loro `VersionVector` (base64); when provided, returns missing `server_update`.
 */
clientVersionVector?: string, origin?: string, summary?: string, };

export type NoteCollabImportResult = { noteId: NoteId, seq: number, versionVector: string, frontiers: string, files: Array<NoteFileMeta>, deleted: Array<string>,
/**
 * Base64-encoded server updates missing from `client_version_vector`, when requested.
 */
serverUpdate?: string, serverSnapshot?: boolean, };

export const LinkEntityKindValues = ["note", "issue"] as const;
export type LinkEntityKind = (typeof LinkEntityKindValues)[number];

export const LinkRelationValues = ["link", "embed"] as const;
export type LinkRelation = (typeof LinkRelationValues)[number];

export type NoteLinkRef = { kind: LinkEntityKind, id: string, relation: LinkRelation, title?: string, };

export type NoteTreeMoveRequest = { id: NoteId, parentId?: NoteId, sortOrder: number, };

export type NoteLink = { id: string, sourceKind: LinkEntityKind, sourceId: string, targetKind: LinkEntityKind, targetId: string, relation: LinkRelation, title?: string, noteType?: NoteType, createdAt: number, };

export type NoteLinkListRequest = { entityKind: LinkEntityKind, entityId: string, };

export type NoteLinkListResult = { outgoing: Array<NoteLink>, backlinks: Array<NoteLink>, };

export type DocKpiItem = { label: string, value: string, delta?: string, tone?: string, };

export type DocChartSeries = { name: string, data: Array<number>, };

export type DocColumn = { blocks: Array<DocBlock>, };

export type BlockKind = { "type": "prose", text: string, } | { "type": "heading", level: number, text: string, } | { "type": "list", ordered: boolean, items: Array<string>, } | { "type": "todo", checked: boolean, text: string, } | { "type": "callout", tone: string, title?: string, text: string, } | { "type": "code", language?: string, code: string, } | { "type": "kpi", items: Array<DocKpiItem>, } | { "type": "chart", title?: string, kind: string, labels: Array<string>, series: Array<DocChartSeries>, } | { "type": "diagram", title?: string, source: string, } | { "type": "compare", title?: string, beforeLabel: string, afterLabel: string, beforeAsset: string, afterAsset: string, } | { "type": "media", mediaKind: string, src: string, caption?: string, } | { "type": "preview", entry: string, height?: number, title?: string, } | { "type": "baseEmbed", noteId: NoteId, sheetId?: string, viewId?: string, } | { "type": "issueCard", issueId: IssueId, } | { "type": "issueList", repo?: string, status?: string, tag?: string, limit?: number, } | { "type": "columns", columns: Array<DocColumn>, } | { "type": "pageBreak", title?: string, speakerNotes?: string, } | { "type": "divider" } | { "type": "quote", text: string, attribution?: string, } | { "type": "toggle", title: string, text: string, } | { "type": "table", headers: Array<string>, rows: Array<Array<string>>, alignments?: Array<string>, } | { "type": "bookmark", url: string, title?: string, description?: string, } | { "type": "toc", maxLevel?: number, } | { "type": "math", expression: string, display?: boolean, };

export type DocBlock = { id: string, collapsed?: boolean, children?: Array<DocBlock>, } & ({ "type": "prose", text: string, } | { "type": "heading", level: number, text: string, } | { "type": "list", ordered: boolean, items: Array<string>, } | { "type": "todo", checked: boolean, text: string, } | { "type": "callout", tone: string, title?: string, text: string, } | { "type": "code", language?: string, code: string, } | { "type": "kpi", items: Array<DocKpiItem>, } | { "type": "chart", title?: string, kind: string, labels: Array<string>, series: Array<DocChartSeries>, } | { "type": "diagram", title?: string, source: string, } | { "type": "compare", title?: string, beforeLabel: string, afterLabel: string, beforeAsset: string, afterAsset: string, } | { "type": "media", mediaKind: string, src: string, caption?: string, } | { "type": "preview", entry: string, height?: number, title?: string, } | { "type": "baseEmbed", noteId: NoteId, sheetId?: string, viewId?: string, } | { "type": "issueCard", issueId: IssueId, } | { "type": "issueList", repo?: string, status?: string, tag?: string, limit?: number, } | { "type": "columns", columns: Array<DocColumn>, } | { "type": "pageBreak", title?: string, speakerNotes?: string, } | { "type": "divider" } | { "type": "quote", text: string, attribution?: string, } | { "type": "toggle", title: string, text: string, } | { "type": "table", headers: Array<string>, rows: Array<Array<string>>, alignments?: Array<string>, } | { "type": "bookmark", url: string, title?: string, description?: string, } | { "type": "toc", maxLevel?: number, } | { "type": "math", expression: string, display?: boolean, });

export type DocView = { noteId: NoteId, title: string, blocks: Array<DocBlock>, slideCount: number, wordCount: number, extractedLinks: Array<NoteLinkRef>, };

export type NoteDocViewRequest = { id: NoteId, };

export type NoteDocAppendBlockRequest = { id: NoteId, block: DocBlock, afterBlockId?: string, origin?: string, };

export const BaseColumnKindValues = ["text", "number", "select", "multiSelect", "date", "checkbox", "media", "issueRef", "agentRef", "agentAction", "noteRef", "formula"] as const;
export type BaseColumnKind = (typeof BaseColumnKindValues)[number];

export const BaseViewKindValues = ["table", "board", "gallery", "timeline"] as const;
export type BaseViewKind = (typeof BaseViewKindValues)[number];

export const BaseSummaryOpValues = ["count", "sum", "avg", "min", "max"] as const;
export type BaseSummaryOp = (typeof BaseSummaryOpValues)[number];

export const BaseFilterOpValues = ["eq", "neq", "contains", "notEmpty", "empty"] as const;
export type BaseFilterOp = (typeof BaseFilterOpValues)[number];

export type BaseSelectOption = { value: string, label?: string, color?: string, };

export type BaseAgentColumnConfig = { agentId?: string, promptTemplate: string, targetColumnId?: string, spawnIssueRepo?: string, };

export type BaseColumn = { id: string, name: string, kind: BaseColumnKind, options?: Array<BaseSelectOption>, agentConfig?: BaseAgentColumnConfig, formula?: string, width?: number, };

export type BaseCellValue = { "_tag": "text", value: string, } | { "_tag": "number", value: number, } | { "_tag": "bool", value: boolean, } | { "_tag": "strings", items: Array<string>, } | { "_tag": "issueRef", issueId: IssueId, } | { "_tag": "noteRef", noteId: NoteId, } | { "_tag": "agentRef", agentId: string, } | { "_tag": "agentRun", status: string, summary?: string, sessionId?: SessionId, spawnedIssueId?: IssueId, updatedAt: number, };

export type BaseRow = { id: string, cells: { [key in string]: BaseCellValue }, pageNoteId?: NoteId, createdAt: number, updatedAt: number, };

export type BaseFilterRule = { columnId: string, op: BaseFilterOp, value?: string, };

export type BaseSortRule = { columnId: string, desc: boolean, };

export type BaseSummaryConfig = { columnId: string, op: BaseSummaryOp, };

export type BaseViewConfig = { id: string, name: string, kind: BaseViewKind, groupBy?: string, hiddenColumns?: Array<string>, filters?: Array<BaseFilterRule>, sorts?: Array<BaseSortRule>, summaries?: Array<BaseSummaryConfig>, };

export type BaseSheet = { id: string, name: string, columns: Array<BaseColumn>, rows: Array<BaseRow>, views: Array<BaseViewConfig>, };

export type BaseSheetMeta = { id: string, name: string, rowCount: number, };

export type BaseGroupSnapshot = { key: string, label: string, rowIds: Array<string>, count: number, };

export type BaseSummaryResult = { columnId: string, op: BaseSummaryOp, value: string, };

export type BaseViewRequest = { id: NoteId, sheetId?: string, viewId?: string, };

export type BaseViewSnapshot = { noteId: NoteId, sheets: Array<BaseSheetMeta>, activeSheetId: string, activeViewId: string, activeViewKind: BaseViewKind, columns: Array<BaseColumn>, rows: Array<BaseRow>, groups: Array<BaseGroupSnapshot>, summaries: Array<BaseSummaryResult>, totalRows: number, };

export type BaseUpsertRowRequest = { id: NoteId, sheetId?: string, rowId?: string, cells: { [key in string]: BaseCellValue }, origin?: string, };

export type BaseRunAgentColumnRequest = { id: NoteId, sheetId?: string, columnId: string, rowIds?: Array<string>, origin?: string, };

export type BaseRunAgentColumnResult = { noteId: NoteId, sheetId: string, columnId: string, executed: number, updatedRowIds: Array<string>, spawnedIssueIds: Array<string>, };
