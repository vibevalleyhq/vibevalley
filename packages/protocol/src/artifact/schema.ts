import { Schema } from "effect";

import type { Codec } from "../codec";
import { ArtifactId, BlockId, IssueId, SuggestionId } from "../common/schema";
import * as T from "../shapes";

export const ArtifactBody: Codec<T.ArtifactBody> = Schema.Literals(T.ArtifactBodyValues);

export const ArtifactKind: Codec<T.ArtifactKind> = Schema.Literals(T.ArtifactKindValues);

export const ArtifactDisplay: Codec<T.ArtifactDisplay> = Schema.Literals(T.ArtifactDisplayValues);

export const ArtifactCard: Codec<T.ArtifactCard> = Schema.Struct({
  id: ArtifactId,
  title: Schema.String,
  body: ArtifactBody,
  version: Schema.Finite,
  note: Schema.String,
  display: Schema.optionalKey(ArtifactDisplay),
});

export const ArtifactVersion: Codec<T.ArtifactVersion> = Schema.Struct({
  version: Schema.Finite,
  size: Schema.Finite,
  note: Schema.String,
  by: Schema.String,
  byName: Schema.String,
  at: Schema.Finite,
  channel: Schema.String,
  number: Schema.optionalKey(Schema.Finite),
});

export const Artifact: Codec<T.Artifact> = Schema.Struct({
  id: ArtifactId,
  title: Schema.String,
  body: ArtifactBody,
  display: Schema.optionalKey(ArtifactDisplay),
  channel: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.Struct({ channel: Schema.String, number: Schema.Finite })),
  issue: Schema.optionalKey(IssueId),
  by: Schema.String,
  byName: Schema.String,
  version: Schema.Finite,
  seq: Schema.Finite,
  versions: Schema.mutable(Schema.Array(ArtifactVersion)),
  at: Schema.Finite,
  updated: Schema.Finite,
});

export const ArtifactRequest: Codec<T.ArtifactRequest> = Schema.Struct({
  title: Schema.String,
  kind: ArtifactKind,
  display: Schema.optionalKey(ArtifactDisplay),
  content: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
});

export const ArtifactVersionRequest: Codec<T.ArtifactVersionRequest> = Schema.Struct({
  id: ArtifactId,
  content: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

export const HtmlAnchor: Codec<T.HtmlAnchor> = Schema.Struct({
  kind: Schema.Literal("text"),
  exact: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String,
});

export const ArtifactHtmlEdit: Codec<T.ArtifactHtmlEdit> = Schema.Struct({
  id: ArtifactId,
  version: Schema.Finite,
  anchor: HtmlAnchor,
  text: Schema.String,
});

export const ArtifactUpdateRequest: Codec<T.ArtifactUpdateRequest> = Schema.Struct({
  id: ArtifactId,
  title: Schema.optionalKey(Schema.String),
  display: Schema.optionalKey(ArtifactDisplay),
});

const shellCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const shellTime = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 86_400 }));
const shellWords = Schema.mutable(Schema.Array(Schema.String.check(Schema.isMaxLength(10_000))).check(Schema.isMaxLength(10_000)));

export const HtmlShellMessage: Codec<T.HtmlShellMessage> = Schema.Union([
  Schema.Struct({ vibevalley: Schema.Literal("selection"), anchor: HtmlAnchor }),
  Schema.Struct({
    vibevalley: Schema.Literal("ready"),
    display: ArtifactDisplay,
    pages: Schema.optionalKey(shellCount),
    titles: Schema.optionalKey(shellWords),
    notes: Schema.optionalKey(shellWords),
    duration: Schema.optionalKey(shellTime),
  }),
  Schema.Struct({ vibevalley: Schema.Literal("at"), page: Schema.optionalKey(shellCount), time: Schema.optionalKey(shellTime) }),
]);

export const HtmlShellCommand: Codec<T.HtmlShellCommand> = Schema.Union([
  Schema.Struct({ vibevalley: Schema.Literal("goto"), page: shellCount }),
  Schema.Struct({ vibevalley: Schema.Literal("seek"), time: shellTime }),
  Schema.Struct({ vibevalley: Schema.Literal("play") }),
  Schema.Struct({ vibevalley: Schema.Literal("pause") }),
]);

export const ArtifactListRequest: Codec<T.ArtifactListRequest> = Schema.Struct({
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
});

export const ArtifactReadRequest: Codec<T.ArtifactReadRequest> = Schema.Struct({
  id: ArtifactId,
  version: Schema.optionalKey(Schema.Finite),
});

export const ArtifactContent: Codec<T.ArtifactContent> = Schema.Struct({ version: Schema.Finite, content: Schema.String });

export const BlockRef: Codec<T.BlockRef> = Schema.Struct({
  artifactId: ArtifactId,
  blockId: BlockId,
  rev: Schema.Finite,
});

export const QuotedBlock: Codec<T.QuotedBlock> = Schema.Struct({
  artifactId: ArtifactId,
  blockId: BlockId,
  rev: Schema.Finite,
  title: Schema.String,
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  nowRev: Schema.optionalKey(Schema.Finite),
  deleted: Schema.optionalKey(Schema.Boolean),
});

export const SpanMarks: Codec<T.SpanMarks> = Schema.Struct({
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Schema.Boolean),
  strike: Schema.optionalKey(Schema.Boolean),
  link: Schema.optionalKey(Schema.String),
});

export const TextSpan: Codec<T.TextSpan> = Schema.Struct({
  t: Schema.String,
  marks: SpanMarks,
});

export const BlockAttrs: Codec<T.BlockAttrs> = Schema.Struct({
  level: Schema.optionalKey(Schema.Finite),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
  src: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  alt: Schema.optionalKey(Schema.String),
  issueId: Schema.optionalKey(IssueId),
  memoryId: Schema.optionalKey(Schema.String),
});

export const BlockType: Codec<T.BlockType> = Schema.Literals(T.BlockTypeValues);

const blockInputFields = {
  id: BlockId,
  parentId: Schema.optionalKey(BlockId),
  orderKey: Schema.String,
  type: BlockType,
  attrs: BlockAttrs,
  text: Schema.mutable(Schema.Array(TextSpan)),
};

export const BlockInput: Codec<T.BlockInput> = Schema.Struct(blockInputFields);

export const Block: Codec<T.Block> = Schema.Struct({
  ...blockInputFields,
  artifactId: ArtifactId,
  rev: Schema.Finite,
  deleted: Schema.optionalKey(Schema.Boolean),
  updatedBy: Schema.String,
  updated: Schema.Finite,
});

export const BlockSnapshot: Codec<T.BlockSnapshot> = Schema.Struct({
  artifact: Artifact,
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const ArtifactMarkdown: Codec<T.ArtifactMarkdown> = Schema.Struct({
  markdown: Schema.String,
});

export const BlockOpInsertBlock: Codec<T.BlockOpInsertBlock> = Schema.Struct({
  op: Schema.Literal("insert_block"),
  block: BlockInput,
});

export const BlockOpUpdateText: Codec<T.BlockOpUpdateText> = Schema.Struct({
  op: Schema.Literal("update_text"),
  blockId: BlockId,
  baseRev: Schema.Finite,
  text: Schema.mutable(Schema.Array(TextSpan)),
});

export const BlockOpSetAttrs: Codec<T.BlockOpSetAttrs> = Schema.Struct({
  op: Schema.Literal("set_attrs"),
  blockId: BlockId,
  attrs: BlockAttrs,
  unset: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const BlockOpSetType: Codec<T.BlockOpSetType> = Schema.Struct({
  op: Schema.Literal("set_type"),
  blockId: BlockId,
  type: BlockType,
  attrs: BlockAttrs,
});

export const BlockOpMoveBlock: Codec<T.BlockOpMoveBlock> = Schema.Struct({
  op: Schema.Literal("move_block"),
  blockId: BlockId,
  parentId: Schema.optionalKey(BlockId),
  orderKey: Schema.String,
});

export const BlockOpDeleteBlock: Codec<T.BlockOpDeleteBlock> = Schema.Struct({
  op: Schema.Literal("delete_block"),
  blockId: BlockId,
});

export const BlockOpRestoreBlock: Codec<T.BlockOpRestoreBlock> = Schema.Struct({
  op: Schema.Literal("restore_block"),
  blockId: BlockId,
});

export const BlockOpSplitBlock: Codec<T.BlockOpSplitBlock> = Schema.Struct({
  op: Schema.Literal("split_block"),
  blockId: BlockId,
  baseRev: Schema.Finite,
  offset: Schema.Finite,
  newBlock: BlockInput,
});

export const BlockOpMergeBlocks: Codec<T.BlockOpMergeBlocks> = Schema.Struct({
  op: Schema.Literal("merge_blocks"),
  targetId: BlockId,
  sourceId: BlockId,
});

export const BlockOp: Codec<T.BlockOp> = Schema.Union([
  BlockOpInsertBlock,
  BlockOpUpdateText,
  BlockOpSetAttrs,
  BlockOpSetType,
  BlockOpMoveBlock,
  BlockOpDeleteBlock,
  BlockOpRestoreBlock,
  BlockOpSplitBlock,
  BlockOpMergeBlocks,
]);

export const BlockSubmit: Codec<T.BlockSubmit> = Schema.Struct({
  batchId: Schema.String,
  lastSeq: Schema.Finite,
  ops: Schema.mutable(Schema.Array(BlockOp)),
});

export const BlockOpStatus: Codec<T.BlockOpStatus> = Schema.Literals(T.BlockOpStatusValues);

export const BlockCreate: Codec<T.BlockCreate> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Finite),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
  text: Schema.String,
  afterBlock: Schema.optionalKey(BlockId),
  parentId: Schema.optionalKey(BlockId),
});

export const BlockUpdate: Codec<T.BlockUpdate> = Schema.Struct({
  block: BlockId,
  baseRev: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Finite),
  checked: Schema.optionalKey(Schema.Boolean),
  language: Schema.optionalKey(Schema.String),
});

export const BlockDelete: Codec<T.BlockDelete> = Schema.Struct({ block: BlockId });

export const BlockOpResult: Codec<T.BlockOpResult> = Schema.Struct({
  status: BlockOpStatus,
  blockId: BlockId,
  rev: Schema.optionalKey(Schema.Finite),
  text: Schema.optionalKey(Schema.mutable(Schema.Array(TextSpan))),
  yours: Schema.optionalKey(Schema.mutable(Schema.Array(TextSpan))),
  reason: Schema.optionalKey(Schema.String),
  suggestion: Schema.optionalKey(SuggestionId),
});

export const BlockAck: Codec<T.BlockAck> = Schema.Struct({
  batchId: Schema.String,
  seq: Schema.Finite,
  results: Schema.mutable(Schema.Array(BlockOpResult)),
  blocks: Schema.mutable(Schema.Array(Block)),
});

export const ArtifactEvent: Codec<T.ArtifactEvent> = Schema.Union([
  Schema.TaggedStruct("Blocks", { seq: Schema.Finite, blocks: Schema.mutable(Schema.Array(Block)) }),
  Schema.TaggedStruct("Reset", {}),
]);

export const SuggestionStatus: Codec<T.SuggestionStatus> = Schema.Literals(T.SuggestionStatusValues);

export const SuggestionChange: Codec<T.SuggestionChange> = Schema.Struct({
  text: Schema.optionalKey(Schema.mutable(Schema.Array(TextSpan))),
  type: Schema.optionalKey(BlockType),
  attrs: Schema.optionalKey(BlockAttrs),
  unset: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  delete: Schema.optionalKey(Schema.Boolean),
});

export const Suggestion: Codec<T.Suggestion> = Schema.Struct({
  id: SuggestionId,
  artifactId: ArtifactId,
  blockId: BlockId,
  author: Schema.String,
  baseRev: Schema.Finite,
  change: SuggestionChange,
  status: SuggestionStatus,
  createdAt: Schema.Finite,
  resolvedAt: Schema.optionalKey(Schema.Finite),
  resolvedBy: Schema.optionalKey(Schema.String),
});

export const SuggestionCreate: Codec<T.SuggestionCreate> = Schema.Struct({
  block: BlockId,
  baseRev: Schema.Finite,
  change: SuggestionChange,
});

export const SuggestionEvent: Codec<T.SuggestionEvent> = Schema.TaggedStruct("Suggestions", {
  suggestions: Schema.mutable(Schema.Array(Suggestion)),
});
