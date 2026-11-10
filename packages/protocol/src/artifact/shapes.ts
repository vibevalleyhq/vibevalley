import type { ArtifactId, BlockId, IssueId, SuggestionId } from "../common/shapes";

/** What a block is, which says what its attrs and text hold: heading (Attrs.Level 1 to 3), todo (Attrs.Checked), code (Attrs.Language. */
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

/** What the user and the agents leave for people to read (docs/subsystems/artifact.md). */
export const ArtifactBodyValues = ["blocks", "html"] as const;
export type ArtifactBody = (typeof ArtifactBodyValues)[number];

/** What a maker hands in: a whole HTML page, or Markdown, which is read into blocks. */
export const ArtifactKindValues = ["html", "markdown"] as const;
export type ArtifactKind = (typeof ArtifactKindValues)[number];

/** How the workbench shows an html artifact: a page as it is, a deck of slides, or an animation on a timeline. */
export const ArtifactDisplayValues = ["page", "slides", "motion"] as const;
export type ArtifactDisplay = (typeof ArtifactDisplayValues)[number];

/** A version's content, a GET like an attachment's: an <iframe src> can only GET. */
export const artifactPrefix = "/api/v1/artifact/";
export const artifactPath = (id: string, version: number) => `${artifactPrefix}${id}/${version}`;

/** What a message says of the artifact it announces. */
export interface ArtifactCard {
  id: ArtifactId;
  title: string;
  body: ArtifactBody;
  /** html: the version announced; blocks: 0. */
  version: number;
  /** What this version changed, in the maker's words. */
  note: string;
}

export interface ArtifactVersion {
  version: number;
  size: number;
  note: string;
  /** Who made it: a profile's id, or the user's. */
  by: string;
  byName: string;
  at: number;
  /** The message that announced it, where its comments are the replies. */
  channel: string;
  number?: number;
}

export interface Artifact {
  id: ArtifactId;
  title: string;
  body: ArtifactBody;
  /** html: how it is shown; blocks: none. */
  display?: ArtifactDisplay;
  /** The channel or thread it was announced in; none for one the user started on the page. */
  channel?: string;
  /** The message that first announced it: a blocks one's comments are the replies to it. */
  said?: { channel: string; number: number };
  issue?: IssueId;
  by: string;
  byName: string;
  /** html: the latest version; blocks: 0. */
  version: number;
  /** blocks: the batches taken; html: 0. */
  seq: number;
  /** html: each version, oldest first; blocks: none. */
  versions: ArtifactVersion[];
  at: number;
  updated: number;
}

/** Without content, an empty blocks artifact to write in, not announced (the user's New). */
export interface ArtifactRequest {
  title: string;
  kind: ArtifactKind;
  /** html only; none: page. */
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

/** Some words in an HTML artifact's page, as the W3C Web Annotation TextQuoteSelector says them. Text is the page's text nodes outside <script> and <style>. */
export interface HtmlAnchor {
  kind: "text";
  exact: string;
  prefix: string;
  suffix: string;
}

/** The user's words in place of the anchored ones, in the version they were read in; kept as the next version. */
export interface ArtifactHtmlEdit {
  id: ArtifactId;
  version: number;
  anchor: HtmlAnchor;
  text: string;
}

/** Its title or how it is shown, as the user changes them; display is for html ones only. */
export interface ArtifactUpdateRequest {
  id: ArtifactId;
  title?: string;
  display?: ArtifactDisplay;
}

// The page's own scripts can send the same messages, so what a page says is only ever data for the shell to show:
// saving a selection is the user's button, and no message makes the workbench do anything outside the frame.
/** What the page (its vv runtime) tells the shell around it. */
export type HtmlShellMessage =
  | { vibevalley: "selection"; anchor: HtmlAnchor }
  /** The page is laid out: slides say how many and each one's title and notes, motion its length in seconds. */
  | { vibevalley: "ready"; display: ArtifactDisplay; pages?: number; titles?: string[]; notes?: string[]; duration?: number }
  /** Where it is now: the slide shown (0-based), or the time (seconds). */
  | { vibevalley: "at"; page?: number; time?: number };

/** What the shell tells the page's runtime: show a slide, go to a time, play or pause. */
export type HtmlShellCommand = { vibevalley: "goto"; page: number } | { vibevalley: "seek"; time: number } | { vibevalley: "play" } | { vibevalley: "pause" };

export interface ArtifactListRequest {
  channel?: string;
  issue?: string;
}

/** A version's words; the latest when version is absent. */
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

/** The content and position decided by the author of a new block. */
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

/** Told apart by `op`. */
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

/** A block a message points at, by the version it was read at. */
export interface BlockRef {
  artifactId: ArtifactId;
  blockId: BlockId;
  rev: number;
}

/** The block as the prompt reads it: the version the message quoted, and how it reads now. */
export interface QuotedBlock extends BlockRef {
  title: string;
  type?: string;
  text?: string;
  nowRev?: number;
  deleted?: boolean;
}

/** A block inserted under a parent, next to a named sibling. */
export interface BlockCreate {
  /** paragraph (the default), heading, bulleted, numbered, todo, quote or code. */
  type?: string;
  /** A heading's: 1 to 3, 2 when none. */
  level?: number;
  /** A todo's. */
  checked?: boolean;
  /** A code block's language. */
  language?: string;
  text: string;
  /** Insert right after this sibling; "" is the first, absent is the end. */
  afterBlock?: BlockId;
  /** The parent to insert under; absent is the top level. */
  parentId?: BlockId;
}

/** A block's words, type or attributes changed against the rev it was read at: a newer rev on changed words is a conflict. */
export interface BlockUpdate {
  block: BlockId;
  baseRev: number;
  /** Its whole new text, not a delta. */
  text?: string;
  /** The new type; attrs say what the new type needs. */
  type?: string;
  /** A heading's level. */
  level?: number;
  /** A todo's checked state. */
  checked?: boolean;
  /** A code block's language. */
  language?: string;
}

export interface BlockDelete {
  block: BlockId;
}

/** A change to a blocks artifact, for a page following it: the blocks a batch changed, or Reset when it is too far behind. */
export type ArtifactEvent = ArtifactEventBlocks | { readonly _tag: "Reset" };

export interface ArtifactEventBlocks {
  readonly _tag: "Blocks";
  readonly seq: number;
  readonly blocks: Block[];
}

export const SuggestionStatusValues = ["open", "accepted", "rejected"] as const;
export type SuggestionStatus = (typeof SuggestionStatusValues)[number];

/** What a suggestion would do to its block: a change of words, of type or attrs, or a deletion. At least one is set. */
export interface SuggestionChange {
  readonly text?: TextSpan[];
  readonly type?: BlockType;
  readonly attrs?: BlockAttrs;
  readonly unset?: string[];
  readonly delete?: boolean;
}

/** A change an agent proposed to a block the user wrote; the user accepts or rejects it. */
export interface Suggestion {
  readonly id: SuggestionId;
  readonly artifactId: ArtifactId;
  readonly blockId: BlockId;
  /** The agent's profile id. */
  readonly author: string;
  /** The block's rev the agent read. */
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

/** Each change to the open suggestions, the whole list as it now is. */
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
  /** When an agent changed a block the user wrote: the suggestion it made instead. */
  suggestion?: SuggestionId;
}

export interface BlockAck {
  batchId: string;
  seq: number;
  results: BlockOpResult[];
  blocks: Block[];
}
