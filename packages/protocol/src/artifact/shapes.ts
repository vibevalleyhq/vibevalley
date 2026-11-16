import type { ArtifactId, BlockId, IssueId, SuggestionId } from "../common/shapes";

export const BlockTypeValues = [
  "paragraph",
  "heading",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "code",
  "divider",
  "image",
  "issue_ref",
  "memory_item",
] as const;
export type BlockType = (typeof BlockTypeValues)[number];

export const ArtifactBodyValues = ["blocks", "html", "store"] as const;
export type ArtifactBody = (typeof ArtifactBodyValues)[number];

export const ArtifactKindValues = ["html", "markdown", "store"] as const;
export type ArtifactKind = (typeof ArtifactKindValues)[number];

export const ArtifactTypeValues = ["docs", "slides", "dashboard", "motion", "whiteboard", "design", "design-system"] as const;
export type ArtifactType = (typeof ArtifactTypeValues)[number];

export const ArtifactDisplayValues = ["page", "slides", "motion"] as const;
export type ArtifactDisplay = (typeof ArtifactDisplayValues)[number];

export const ArtifactEntryKindValues = ["text", "json", "asset"] as const;
export type ArtifactEntryKind = (typeof ArtifactEntryKindValues)[number];

export const ArtifactEntryOpValues = ["set", "patch", "delete", "copy"] as const;
export type ArtifactEntryOp = (typeof ArtifactEntryOpValues)[number];

/** Served over GET because <iframe src> cannot POST. */
const artifactPrefix = "/api/v1/artifact/";
export const artifactPath = (id: string, version: number) => `${artifactPrefix}${id}/${version}`;
export const artifactViewPath = (id: string) => `${artifactPrefix}${id}/view`;

export interface ArtifactCard {
  id: ArtifactId;
  title: string;
  body: ArtifactBody;
  /** Announced version for html; seq for store; 0 for blocks. */
  version: number;
  note: string;
  /** Omit defaults to "page" for cards created before display modes existed. */
  display?: ArtifactDisplay;
  artifactType?: ArtifactType;
}

export interface ArtifactVersion {
  version: number;
  size: number;
  note: string;
  by: string;
  byName: string;
  at: number;
  channel: string;
  number?: number;
}

export interface Artifact {
  id: ArtifactId;
  title: string;
  body: ArtifactBody;
  artifactType?: ArtifactType;
  /** True on the standing default design-system artifact consumed when creating visual artifacts. */
  isDefault: boolean;
  /** html only; absent on blocks and store. */
  display?: ArtifactDisplay;
  channel?: string;
  said?: { channel: string; number: number };
  issue?: IssueId;
  by: string;
  byName: string;
  /** Latest version for html; 0 for blocks and store. */
  version: number;
  /** Committed batch count for blocks and store; 0 for html. */
  seq: number;
  /** Oldest first for html; empty on blocks and store. */
  versions: ArtifactVersion[];
  at: number;
  updated: number;
}

export interface ArtifactEntryWriteInput {
  op: ArtifactEntryOp;
  path: string;
  kind?: ArtifactEntryKind;
  /** UTF-8 text for text, JSON text for json/patch, or attachment id for asset. */
  value?: string;
  from?: string;
  mime?: string;
  /** Optimistic concurrency guard: 0 requires the path not to exist; >0 must match current rev. */
  ifRev?: number;
}

export interface ArtifactEntry {
  artifactId: ArtifactId;
  path: string;
  kind: ArtifactEntryKind;
  mime: string;
  size: number;
  rev: number;
  updatedBy: string;
  updated: number;
  value?: string;
  attachmentId?: string;
}

export interface ArtifactEntrySnapshot {
  artifact: Artifact;
  seq: number;
  entries: ArtifactEntry[];
}

export interface ArtifactEntryConflict {
  path: string;
  expectedRev: number;
  actualRev: number;
  current: ArtifactEntry | null;
}

export interface ArtifactEntryBatchResult {
  applied: boolean;
  seq: number;
  entries: ArtifactEntry[];
  conflicts: ArtifactEntryConflict[];
}

export interface ArtifactEntryListRequest {
  id: ArtifactId;
  prefix?: string;
  includeValues?: boolean;
}

export interface ArtifactEntryGetRequest {
  id: ArtifactId;
  path: string;
}

export interface ArtifactEntryBatchRequest {
  id: ArtifactId;
  writes: ArtifactEntryWriteInput[];
  note?: string;
  announce?: boolean;
}

export type ArtifactEntryEvent =
  | { readonly _tag: "Entries"; readonly seq: number; readonly entries: ArtifactEntry[]; readonly deleted: string[] }
  | { readonly _tag: "Reset" };

export interface ArtifactTypeInfo {
  type: ArtifactType;
  body: ArtifactBody;
  title: string;
  summary: string;
  references: string[];
  defaultArtifactId: ArtifactId | null;
}

export interface ArtifactTypeReadRequest {
  type: ArtifactType;
  reference?: string;
}

export interface ArtifactTypeGuide {
  type: ArtifactType;
  title: string;
  reference: string | null;
  content: string;
  references: string[];
  defaultArtifactId: ArtifactId | null;
  defaultArtifactTitle: string | null;
}

export interface ArtifactViewContext {
  artifactId: ArtifactId;
  artifactType?: ArtifactType;
  title: string;
  seq?: number;
  version?: number;
  slideId?: string;
  slideIndex?: number;
  time?: number;
  activeArtboard?: string;
  activeDataset?: string;
  activeTab?: string;
  selectedIds?: string[];
  selectedBlockIds?: BlockId[];
  summary?: string;
}

/** Omit content to create an unannounced empty blocks or store artifact. */
export interface ArtifactRequest {
  title: string;
  kind?: ArtifactKind;
  artifactType?: ArtifactType;
  /** html only; defaults to "page". */
  display?: ArtifactDisplay;
  content?: string;
  entries?: ArtifactEntryWriteInput[];
  isDefault?: boolean;
  announce?: boolean;
  note?: string;
  channel?: string;
  issue?: string;
}

export interface ArtifactVersionRequest {
  id: ArtifactId;
  content: string;
  note?: string;
}

/** W3C Web Annotation TextQuoteSelector over text nodes outside <script> and <style>. */
export interface HtmlAnchor {
  kind: "text";
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ArtifactHtmlEdit {
  id: ArtifactId;
  version: number;
  anchor: HtmlAnchor;
  text: string;
}

export interface ArtifactUpdateRequest {
  id: ArtifactId;
  title?: string;
  display?: ArtifactDisplay;
  isDefault?: boolean;
}

// Untrusted iframe scripts can forge these messages; treat payloads strictly as UI display hints.
export type HtmlShellMessage =
  | { vibevalley: "selection"; anchor: HtmlAnchor; path?: string }
  /** duration is in seconds. */
  | {
      vibevalley: "ready";
      display: ArtifactDisplay;
      pages?: number;
      titles?: string[];
      notes?: string[];
      fragments?: number[];
      duration?: number;
      fps?: number;
      chapters?: { at: number; label: string }[];
    }
  /** page and fragment are 0-based; time is in seconds. */
  | { vibevalley: "at"; page?: number; fragment?: number; time?: number; playing?: boolean }
  | { vibevalley: "recorded"; ok: boolean; mimeType?: string; base64?: string; reason?: string };

export type HtmlShellCommand =
  | { vibevalley: "goto"; page: number; fragment?: number }
  | { vibevalley: "step"; delta: number }
  | { vibevalley: "seek"; time: number }
  | { vibevalley: "play" }
  | { vibevalley: "pause" }
  | { vibevalley: "record"; fps?: number };

export interface ArtifactListRequest {
  channel?: string;
  issue?: string;
  artifactType?: ArtifactType;
}

export interface ArtifactReadRequest {
  id: ArtifactId;
  version?: number;
}

export interface ArtifactContent {
  version: number;
  content: string;
}

export interface SpanMarks {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export interface TextSpan {
  t: string;
  marks: SpanMarks;
}

export interface BlockAttrs {
  level?: number;
  checked?: boolean;
  language?: string;
  src?: string;
  width?: number;
  height?: number;
  alt?: string;
  issueId?: IssueId;
  memoryId?: string;
}

export interface BlockInput {
  id: BlockId;
  parentId?: BlockId;
  orderKey: string;
  type: BlockType;
  attrs: BlockAttrs;
  text: TextSpan[];
}

export interface Block extends BlockInput {
  artifactId: ArtifactId;
  rev: number;
  deleted?: boolean;
  updatedBy: string;
  updated: number;
}

export interface BlockSnapshot {
  artifact: Artifact;
  blocks: Block[];
}

export interface ArtifactMarkdown {
  markdown: string;
}

export type BlockOp =
  | BlockOpInsertBlock
  | BlockOpUpdateText
  | BlockOpSetAttrs
  | BlockOpSetType
  | BlockOpMoveBlock
  | BlockOpDeleteBlock
  | BlockOpRestoreBlock
  | BlockOpSplitBlock
  | BlockOpMergeBlocks;

export interface BlockOpInsertBlock {
  op: "insert_block";
  block: BlockInput;
}

export interface BlockOpUpdateText {
  op: "update_text";
  blockId: BlockId;
  baseRev: number;
  text: TextSpan[];
}

export interface BlockOpSetAttrs {
  op: "set_attrs";
  blockId: BlockId;
  attrs: BlockAttrs;
  unset?: string[];
}

export interface BlockOpSetType {
  op: "set_type";
  blockId: BlockId;
  type: BlockType;
  attrs: BlockAttrs;
}

export interface BlockOpMoveBlock {
  op: "move_block";
  blockId: BlockId;
  parentId?: BlockId;
  orderKey: string;
}

export interface BlockOpDeleteBlock {
  op: "delete_block";
  blockId: BlockId;
}

export interface BlockOpRestoreBlock {
  op: "restore_block";
  blockId: BlockId;
}

export interface BlockOpSplitBlock {
  op: "split_block";
  blockId: BlockId;
  baseRev: number;
  offset: number;
  newBlock: BlockInput;
}

export interface BlockOpMergeBlocks {
  op: "merge_blocks";
  targetId: BlockId;
  sourceId: BlockId;
}

export interface BlockSubmit {
  batchId: string;
  lastSeq: number;
  ops: BlockOp[];
}

export const BlockOpStatusValues = ["applied", "merged", "conflict", "noop", "rejected"] as const;
export type BlockOpStatus = (typeof BlockOpStatusValues)[number];

export interface BlockRef {
  artifactId: ArtifactId;
  blockId: BlockId;
  rev: number;
}

export interface QuotedBlock extends BlockRef {
  title: string;
  type?: string;
  text?: string;
  nowRev?: number;
  deleted?: boolean;
}

export interface BlockCreate {
  type?: string;
  /** 1 to 3; defaults to 2. */
  level?: number;
  checked?: boolean;
  language?: string;
  text: string;
  /** "" inserts first; omit appends at the end. */
  afterBlock?: BlockId;
  /** Omit inserts at the top level. */
  parentId?: BlockId;
}

/** Conflicts when text is changed against a stale baseRev. */
export interface BlockUpdate {
  block: BlockId;
  baseRev: number;
  /** Full replacement text, not a delta. */
  text?: string;
  type?: string;
  level?: number;
  checked?: boolean;
  language?: string;
}

export interface BlockDelete {
  block: BlockId;
}

/** Reset is sent when the client falls too far behind the batch log. */
export type ArtifactEvent = ArtifactEventBlocks | { readonly _tag: "Reset" };

interface ArtifactEventBlocks {
  readonly _tag: "Blocks";
  readonly seq: number;
  readonly blocks: Block[];
}

export const SuggestionStatusValues = ["open", "accepted", "rejected"] as const;
export type SuggestionStatus = (typeof SuggestionStatusValues)[number];

/** At least one field must be set. */
export interface SuggestionChange {
  readonly text?: TextSpan[];
  readonly type?: BlockType;
  readonly attrs?: BlockAttrs;
  readonly unset?: string[];
  readonly delete?: boolean;
}

export interface Suggestion {
  readonly id: SuggestionId;
  readonly artifactId: ArtifactId;
  readonly blockId: BlockId;
  readonly author: string;
  readonly baseRev: number;
  readonly change: SuggestionChange;
  readonly status: SuggestionStatus;
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolvedBy?: string;
}

export interface SuggestionCreate {
  readonly block: BlockId;
  readonly baseRev: number;
  readonly change: SuggestionChange;
}

export interface SuggestionEvent {
  readonly _tag: "Suggestions";
  readonly suggestions: Suggestion[];
}

export interface BlockOpResult {
  status: BlockOpStatus;
  blockId: BlockId;
  rev?: number;
  text?: TextSpan[];
  yours?: TextSpan[];
  reason?: string;
  /** Populated when an agent edit to a user-authored block was diverted into a suggestion. */
  suggestion?: SuggestionId;
}

export interface BlockAck {
  batchId: string;
  seq: number;
  results: BlockOpResult[];
  blocks: Block[];
}
