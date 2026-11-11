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

export const ArtifactBodyValues = ["blocks", "html"] as const;
export type ArtifactBody = (typeof ArtifactBodyValues)[number];

export const ArtifactKindValues = ["html", "markdown"] as const;
export type ArtifactKind = (typeof ArtifactKindValues)[number];

export const ArtifactDisplayValues = ["page", "slides", "motion"] as const;
export type ArtifactDisplay = (typeof ArtifactDisplayValues)[number];

/** Served over GET because <iframe src> cannot POST. */
export const artifactPrefix = "/api/v1/artifact/";
export const artifactPath = (id: string, version: number) => `${artifactPrefix}${id}/${version}`;

export interface ArtifactCard {
  id: ArtifactId;
  title: string;
  body: ArtifactBody;
  /** Announced version for html; 0 for blocks. */
  version: number;
  note: string;
  /** Omit defaults to "page" for cards created before display modes existed. */
  display?: ArtifactDisplay;
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
  /** html only; absent on blocks. */
  display?: ArtifactDisplay;
  channel?: string;
  said?: { channel: string; number: number };
  issue?: IssueId;
  by: string;
  byName: string;
  /** Latest version for html; 0 for blocks. */
  version: number;
  /** Committed batch count for blocks; 0 for html. */
  seq: number;
  /** Oldest first for html; empty on blocks. */
  versions: ArtifactVersion[];
  at: number;
  updated: number;
}

/** Omit content to create an unannounced empty blocks artifact. */
export interface ArtifactRequest {
  title: string;
  kind: ArtifactKind;
  /** html only; defaults to "page". */
  display?: ArtifactDisplay;
  content?: string;
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
}

// Untrusted iframe scripts can forge these messages; treat payloads strictly as UI display hints.
export type HtmlShellMessage =
  | { vibevalley: "selection"; anchor: HtmlAnchor }
  /** duration is in seconds. */
  | { vibevalley: "ready"; display: ArtifactDisplay; pages?: number; titles?: string[]; notes?: string[]; duration?: number }
  /** page is 0-based; time is in seconds. */
  | { vibevalley: "at"; page?: number; time?: number };

export type HtmlShellCommand = { vibevalley: "goto"; page: number } | { vibevalley: "seek"; time: number } | { vibevalley: "play" } | { vibevalley: "pause" };

export interface ArtifactListRequest {
  channel?: string;
  issue?: string;
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
