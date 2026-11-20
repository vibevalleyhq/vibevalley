// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ArtifactId, BlockId, IssueId, SuggestionId } from "../common/shapes.gen";

export const ArtifactBodyValues = ["blocks", "html", "store"] as const;
export type ArtifactBody = (typeof ArtifactBodyValues)[number];

export const ArtifactTypeValues = ["docs", "slides", "dashboard", "motion", "whiteboard", "design", "design-system"] as const;
export type ArtifactType = (typeof ArtifactTypeValues)[number];

export const ArtifactEntryKindValues = ["text", "json", "asset"] as const;
export type ArtifactEntryKind = (typeof ArtifactEntryKindValues)[number];

export const ArtifactEntryOpValues = ["set", "patch", "delete", "copy"] as const;
export type ArtifactEntryOp = (typeof ArtifactEntryOpValues)[number];

export const ArtifactDisplayValues = ["page", "slides", "motion"] as const;
export type ArtifactDisplay = (typeof ArtifactDisplayValues)[number];

export type ArtifactCard = { id: ArtifactId, title: string, body: ArtifactBody,
/**
 * Announced version for html; seq for store; 0 for blocks.
 */
version: number, note: string,
/**
 * Omit defaults to "page" for cards created before display modes existed.
 */
display?: ArtifactDisplay, artifactType?: ArtifactType, };

export type QuotedBlock = { artifactId: ArtifactId, blockId: BlockId, rev: number, title: string, type?: string, text?: string, nowRev?: number, deleted?: boolean, };

export type BlockRef = { artifactId: ArtifactId, blockId: BlockId, rev: number, };

export const ArtifactKindValues = ["html", "markdown", "store"] as const;
export type ArtifactKind = (typeof ArtifactKindValues)[number];

export type ArtifactVersion = { version: number, size: number, note: string, by: string, byName: string, at: number, channel: string, number?: number, };

export type ArtifactSaid = { channel: string, number: number, };

export type Artifact = { id: ArtifactId, title: string, body: ArtifactBody, artifactType?: ArtifactType,
/**
 * True on the standing default design-system artifact consumed when creating visual artifacts.
 */
isDefault: boolean,
/**
 * html only; absent on blocks and store.
 */
display?: ArtifactDisplay, channel?: string, said?: ArtifactSaid, issue?: IssueId, by: string, byName: string,
/**
 * Latest version for html; 0 for blocks and store.
 */
version: number,
/**
 * Committed batch count for blocks and store; 0 for html.
 */
seq: number,
/**
 * Oldest first for html; empty on blocks and store.
 */
versions: Array<ArtifactVersion>, at: number, updated: number, };

export type ArtifactEntryWriteInput = { op: ArtifactEntryOp, path: string, kind?: ArtifactEntryKind,
/**
 * UTF-8 text for text, JSON text for json/patch, or attachment id for asset.
 */
value?: string, from?: string, mime?: string,
/**
 * Optimistic concurrency guard: 0 requires the path not to exist; >0 must match current rev.
 */
ifRev?: number, };

export type ArtifactEntry = { artifactId: ArtifactId, path: string, kind: ArtifactEntryKind, mime: string, size: number, rev: number, updatedBy: string, updated: number, value?: string, attachmentId?: string, };

export type ArtifactEntrySnapshot = { artifact: Artifact, seq: number, entries: Array<ArtifactEntry>, };

export type ArtifactEntryConflict = { path: string, expectedRev: number, actualRev: number, current: ArtifactEntry | null, };

export type ArtifactEntryBatchResult = { applied: boolean, seq: number, entries: Array<ArtifactEntry>, conflicts: Array<ArtifactEntryConflict>, };

export type ArtifactEntryListRequest = { id: ArtifactId, prefix?: string, includeValues?: boolean, };

export type ArtifactEntryGetRequest = { id: ArtifactId, path: string, };

export type ArtifactEntryBatchRequest = { id: ArtifactId, writes: Array<ArtifactEntryWriteInput>, note?: string, announce?: boolean, };

export type ArtifactEntryEvent = { "_tag": "Entries", seq: number, entries: Array<ArtifactEntry>, deleted: Array<string>, } | { "_tag": "Reset", };

export type ArtifactTypeInfo = { type: ArtifactType, body: ArtifactBody, title: string, summary: string, references: Array<string>, defaultArtifactId: ArtifactId | null, };

export type ArtifactTypeReadRequest = { type: ArtifactType, reference?: string, };

export type ArtifactTypeGuide = { type: ArtifactType, title: string, reference: string | null, content: string, references: Array<string>, defaultArtifactId: ArtifactId | null, defaultArtifactTitle: string | null, };

export type ArtifactViewContext = { artifactId: ArtifactId, artifactType?: ArtifactType, title: string, seq?: number, version?: number, slideId?: string, slideIndex?: number, time?: number, activeArtboard?: string, activeDataset?: string, activeTab?: string, selectedIds?: Array<string>, selectedBlockIds?: Array<BlockId>, summary?: string, };

/**
 * Omit content to create an unannounced empty blocks or store artifact.
 */
export type ArtifactRequest = { title: string, kind?: ArtifactKind, artifactType?: ArtifactType,
/**
 * html only; defaults to "page".
 */
display?: ArtifactDisplay, content?: string, entries?: Array<ArtifactEntryWriteInput>, isDefault?: boolean, announce?: boolean, note?: string, channel?: string, issue?: string, };

export type ArtifactVersionRequest = { id: ArtifactId, content: string, note?: string, };

export const HtmlAnchorKindValues = ["text"] as const;
export type HtmlAnchorKind = (typeof HtmlAnchorKindValues)[number];

/**
 * W3C Web Annotation TextQuoteSelector over text nodes outside <script> and <style>.
 */
export type HtmlAnchor = { kind: HtmlAnchorKind, exact: string, prefix: string, suffix: string, };

export type ArtifactHtmlEdit = { id: ArtifactId, version: number, path?: string, anchor: HtmlAnchor, text: string, };

export type ArtifactUpdateRequest = { id: ArtifactId, title?: string, display?: ArtifactDisplay, isDefault?: boolean, };

export type ShellChapter = { at: number, label: string, };

export type HtmlShellMessage = { "vibevalley": "selection", anchor: HtmlAnchor, path?: string, } | { "vibevalley": "ready", display: ArtifactDisplay, pages?: number, titles?: Array<string>, notes?: Array<string>, fragments?: Array<number>, duration?: number, fps?: number, chapters?: Array<ShellChapter>, } | { "vibevalley": "at", page?: number, fragment?: number, time?: number, playing?: boolean, } | { "vibevalley": "recorded", ok: boolean, mimeType?: string, base64?: string, reason?: string, };

export type HtmlShellCommand = { "vibevalley": "goto", page: number, fragment?: number, } | { "vibevalley": "step", delta: number, } | { "vibevalley": "seek", time: number, } | { "vibevalley": "play", } | { "vibevalley": "pause", } | { "vibevalley": "record", fps?: number, };

export type ArtifactListRequest = { channel?: string, issue?: string, artifactType?: ArtifactType, };

export type ArtifactReadRequest = { id: ArtifactId, version?: number, };

export type ArtifactContent = { version: number, content: string, };

export type SpanMarks = { bold?: boolean, italic?: boolean, code?: boolean, strike?: boolean, link?: string, };

export type TextSpan = { t: string, marks: SpanMarks, };

export type BlockAttrs = { level?: number, checked?: boolean, language?: string, src?: string, width?: number, height?: number, alt?: string, issueId?: IssueId, memoryId?: string, };

export const BlockTypeValues = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code", "divider", "image", "issue_ref", "memory_item"] as const;
export type BlockType = (typeof BlockTypeValues)[number];

export type BlockInput = { id: BlockId, parentId?: BlockId, orderKey: string, type: BlockType, attrs: BlockAttrs, text: Array<TextSpan>, };

export type Block = { id: BlockId, parentId?: BlockId, orderKey: string, type: BlockType, attrs: BlockAttrs, text: Array<TextSpan>, artifactId: ArtifactId, rev: number, deleted?: boolean, updatedBy: string, updated: number, };

export type BlockSnapshot = { artifact: Artifact, blocks: Array<Block>, };

export type ArtifactMarkdown = { markdown: string, };

export type BlockOpInsertBlock = { "op": "insert_block", block: BlockInput, };

export type BlockOpUpdateText = { "op": "update_text", blockId: BlockId, baseRev: number, text: Array<TextSpan>, };

export type BlockOpSetAttrs = { "op": "set_attrs", blockId: BlockId, attrs: BlockAttrs, unset?: Array<string>, };

export type BlockOpSetType = { "op": "set_type", blockId: BlockId, type: BlockType, attrs: BlockAttrs, };

export type BlockOpMoveBlock = { "op": "move_block", blockId: BlockId, parentId?: BlockId, orderKey: string, };

export type BlockOpDeleteBlock = { "op": "delete_block", blockId: BlockId, };

export type BlockOpRestoreBlock = { "op": "restore_block", blockId: BlockId, };

export type BlockOpSplitBlock = { "op": "split_block", blockId: BlockId, baseRev: number, offset: number, newBlock: BlockInput, };

export type BlockOpMergeBlocks = { "op": "merge_blocks", targetId: BlockId, sourceId: BlockId, };

export type BlockOp = BlockOpInsertBlock | BlockOpUpdateText | BlockOpSetAttrs | BlockOpSetType | BlockOpMoveBlock | BlockOpDeleteBlock | BlockOpRestoreBlock | BlockOpSplitBlock | BlockOpMergeBlocks;

export type BlockSubmit = { batchId: string, lastSeq: number, ops: Array<BlockOp>, };

export const BlockOpStatusValues = ["applied", "merged", "conflict", "noop", "rejected"] as const;
export type BlockOpStatus = (typeof BlockOpStatusValues)[number];

export type BlockCreate = { type?: string,
/**
 * 1 to 3; defaults to 2.
 */
level?: number, checked?: boolean, language?: string, text: string,
/**
 * "" inserts first; omit appends at the end.
 */
afterBlock?: BlockId,
/**
 * Omit inserts at the top level.
 */
parentId?: BlockId, };

/**
 * Conflicts when text is changed against a stale baseRev.
 */
export type BlockUpdate = { block: BlockId, baseRev: number,
/**
 * Full replacement text, not a delta.
 */
text?: string, type?: string, level?: number, checked?: boolean, language?: string, };

export type BlockDelete = { block: BlockId, };

export type BlockOpResult = { status: BlockOpStatus, blockId: BlockId, rev?: number, text?: Array<TextSpan>, yours?: Array<TextSpan>, reason?: string,
/**
 * Populated when an agent edit to a user-authored block was diverted into a suggestion.
 */
suggestion?: SuggestionId, };

export type BlockAck = { batchId: string, seq: number, results: Array<BlockOpResult>, blocks: Array<Block>, };

/**
 * Reset is sent when the client falls too far behind the batch log.
 */
export type ArtifactEvent = { "_tag": "Blocks", seq: number, blocks: Array<Block>, } | { "_tag": "Reset", };

export const SuggestionStatusValues = ["open", "accepted", "rejected"] as const;
export type SuggestionStatus = (typeof SuggestionStatusValues)[number];

/**
 * At least one field must be set.
 */
export type SuggestionChange = { text?: Array<TextSpan>, type?: BlockType, attrs?: BlockAttrs, unset?: Array<string>, delete?: boolean, };

export type Suggestion = { id: SuggestionId, artifactId: ArtifactId, blockId: BlockId, author: string, baseRev: number, change: SuggestionChange, status: SuggestionStatus, createdAt: number, resolvedAt?: number, resolvedBy?: string, };

export type SuggestionCreate = { block: BlockId, baseRev: number, change: SuggestionChange, };

export const SuggestionEventKindValues = ["Suggestions"] as const;
export type SuggestionEventKind = (typeof SuggestionEventKindValues)[number];

export type SuggestionEvent = { _tag: SuggestionEventKind, suggestions: Array<Suggestion>, };

export type ArtifactGetInput = { id: ArtifactId, };

export type ArtifactDeleteInput = { id: ArtifactId, };

export type ArtifactBlockListInput = { id: ArtifactId, };

export type ArtifactSubmitInput = { id: ArtifactId, batchId: string, lastSeq: number, ops: Array<BlockOp>, };

export type ArtifactBlockCreateInput = { id: ArtifactId, type?: string, level?: number, checked?: boolean, language?: string, text: string, afterBlock?: BlockId, parentId?: BlockId, };

export type ArtifactBlockUpdateInput = { id: ArtifactId, block: BlockId, baseRev: number, text?: string, type?: string, level?: number, checked?: boolean, language?: string, };

export type ArtifactBlockDeleteInput = { id: ArtifactId, block: BlockId, };

export type ArtifactSuggestionListInput = { id: ArtifactId, };

export type ArtifactSuggestionCreateInput = { id: ArtifactId, block: BlockId, baseRev: number, change: SuggestionChange, };

export type ArtifactSuggestionAcceptInput = { id: ArtifactId, suggestion: SuggestionId, };

export type ArtifactMarkdownGetInput = { id: ArtifactId, };

export type ArtifactDemoInput = { id: ArtifactId, };

export type ShellCount = number;

export type ShellTime = number;

export type ShellWords = Array<string>;
