import { z } from "zod";

import type { Codec } from "../codec";
import { ArtifactId, BlockId, IssueId, SuggestionId } from "../common/schema";
import * as T from "./shapes";

const ArtifactBody = z.enum(T.ArtifactBodyValues) satisfies Codec<T.ArtifactBody>;

const ArtifactKind = z.enum(T.ArtifactKindValues) satisfies Codec<T.ArtifactKind>;

const ArtifactDisplay = z.enum(T.ArtifactDisplayValues) satisfies Codec<T.ArtifactDisplay>;

export const ArtifactCard = z.object({
  id: ArtifactId,
  title: z.string(),
  body: ArtifactBody,
  version: z.number(),
  note: z.string(),
  display: z.exactOptional(ArtifactDisplay),
}) satisfies Codec<T.ArtifactCard>;

const ArtifactVersion = z.object({
  version: z.number(),
  size: z.number(),
  note: z.string(),
  by: z.string(),
  byName: z.string(),
  at: z.number(),
  channel: z.string(),
  number: z.exactOptional(z.number()),
}) satisfies Codec<T.ArtifactVersion>;

export const Artifact = z.object({
  id: ArtifactId,
  title: z.string(),
  body: ArtifactBody,
  display: z.exactOptional(ArtifactDisplay),
  channel: z.exactOptional(z.string()),
  said: z.exactOptional(z.object({ channel: z.string(), number: z.number() })),
  issue: z.exactOptional(IssueId),
  by: z.string(),
  byName: z.string(),
  version: z.number(),
  seq: z.number(),
  versions: z.array(ArtifactVersion),
  at: z.number(),
  updated: z.number(),
}) satisfies Codec<T.Artifact>;

export const ArtifactRequest = z.object({
  title: z.string(),
  kind: ArtifactKind,
  display: z.exactOptional(ArtifactDisplay),
  content: z.exactOptional(z.string()),
  note: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactRequest>;

export const ArtifactVersionRequest = z.object({
  id: ArtifactId,
  content: z.string(),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactVersionRequest>;

const HtmlAnchor = z.object({
  kind: z.literal("text"),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
}) satisfies Codec<T.HtmlAnchor>;

export const ArtifactHtmlEdit = z.object({
  id: ArtifactId,
  version: z.number(),
  anchor: HtmlAnchor,
  text: z.string(),
}) satisfies Codec<T.ArtifactHtmlEdit>;

export const ArtifactUpdateRequest = z.object({
  id: ArtifactId,
  title: z.exactOptional(z.string()),
  display: z.exactOptional(ArtifactDisplay),
}) satisfies Codec<T.ArtifactUpdateRequest>;

const shellCount = z.number().int().min(0).max(10_000);
const shellTime = z.number().min(0).max(86_400);
const shellWords = z.array(z.string().max(10_000)).max(10_000);

export const HtmlShellMessage = z.discriminatedUnion("vibevalley", [
  z.object({ vibevalley: z.literal("selection"), anchor: HtmlAnchor }),
  z.object({
    vibevalley: z.literal("ready"),
    display: ArtifactDisplay,
    pages: z.exactOptional(shellCount),
    titles: z.exactOptional(shellWords),
    notes: z.exactOptional(shellWords),
    duration: z.exactOptional(shellTime),
  }),
  z.object({ vibevalley: z.literal("at"), page: z.exactOptional(shellCount), time: z.exactOptional(shellTime) }),
]) satisfies Codec<T.HtmlShellMessage>;

export const ArtifactListRequest = z.object({
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactListRequest>;

export const ArtifactReadRequest = z.object({
  id: ArtifactId,
  version: z.exactOptional(z.number()),
}) satisfies Codec<T.ArtifactReadRequest>;

export const ArtifactContent = z.object({ version: z.number(), content: z.string() }) satisfies Codec<T.ArtifactContent>;

export const BlockRef = z.object({
  artifactId: ArtifactId,
  blockId: BlockId,
  rev: z.number(),
}) satisfies Codec<T.BlockRef>;

export const QuotedBlock = z.object({
  artifactId: ArtifactId,
  blockId: BlockId,
  rev: z.number(),
  title: z.string(),
  type: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  nowRev: z.exactOptional(z.number()),
  deleted: z.exactOptional(z.boolean()),
}) satisfies Codec<T.QuotedBlock>;

const SpanMarks = z.object({
  bold: z.exactOptional(z.boolean()),
  italic: z.exactOptional(z.boolean()),
  code: z.exactOptional(z.boolean()),
  strike: z.exactOptional(z.boolean()),
  link: z.exactOptional(z.string()),
}) satisfies Codec<T.SpanMarks>;

export const TextSpan = z.object({
  t: z.string(),
  marks: SpanMarks,
}) satisfies Codec<T.TextSpan>;

export const BlockAttrs = z.object({
  level: z.exactOptional(z.number()),
  checked: z.exactOptional(z.boolean()),
  language: z.exactOptional(z.string()),
  src: z.exactOptional(z.string()),
  width: z.exactOptional(z.number()),
  height: z.exactOptional(z.number()),
  alt: z.exactOptional(z.string()),
  issueId: z.exactOptional(IssueId),
  memoryId: z.exactOptional(z.string()),
}) satisfies Codec<T.BlockAttrs>;

const BlockType = z.enum(T.BlockTypeValues) satisfies Codec<T.BlockType>;

const blockInputFields = {
  id: BlockId,
  parentId: z.exactOptional(BlockId),
  orderKey: z.string(),
  type: BlockType,
  attrs: BlockAttrs,
  text: z.array(TextSpan),
};

const BlockInput = z.object(blockInputFields) satisfies Codec<T.BlockInput>;

const Block = z.object({
  ...blockInputFields,
  artifactId: ArtifactId,
  rev: z.number(),
  deleted: z.exactOptional(z.boolean()),
  updatedBy: z.string(),
  updated: z.number(),
}) satisfies Codec<T.Block>;

export const BlockSnapshot = z.object({
  artifact: Artifact,
  blocks: z.array(Block),
}) satisfies Codec<T.BlockSnapshot>;

export const ArtifactMarkdown = z.object({
  markdown: z.string(),
}) satisfies Codec<T.ArtifactMarkdown>;

const BlockOpInsertBlock = z.object({
  op: z.literal("insert_block"),
  block: BlockInput,
}) satisfies Codec<T.BlockOpInsertBlock>;

const BlockOpUpdateText = z.object({
  op: z.literal("update_text"),
  blockId: BlockId,
  baseRev: z.number(),
  text: z.array(TextSpan),
}) satisfies Codec<T.BlockOpUpdateText>;

const BlockOpSetAttrs = z.object({
  op: z.literal("set_attrs"),
  blockId: BlockId,
  attrs: BlockAttrs,
  unset: z.exactOptional(z.array(z.string())),
}) satisfies Codec<T.BlockOpSetAttrs>;

const BlockOpSetType = z.object({
  op: z.literal("set_type"),
  blockId: BlockId,
  type: BlockType,
  attrs: BlockAttrs,
}) satisfies Codec<T.BlockOpSetType>;

const BlockOpMoveBlock = z.object({
  op: z.literal("move_block"),
  blockId: BlockId,
  parentId: z.exactOptional(BlockId),
  orderKey: z.string(),
}) satisfies Codec<T.BlockOpMoveBlock>;

const BlockOpDeleteBlock = z.object({
  op: z.literal("delete_block"),
  blockId: BlockId,
}) satisfies Codec<T.BlockOpDeleteBlock>;

const BlockOpRestoreBlock = z.object({
  op: z.literal("restore_block"),
  blockId: BlockId,
}) satisfies Codec<T.BlockOpRestoreBlock>;

const BlockOpSplitBlock = z.object({
  op: z.literal("split_block"),
  blockId: BlockId,
  baseRev: z.number(),
  offset: z.number(),
  newBlock: BlockInput,
}) satisfies Codec<T.BlockOpSplitBlock>;

const BlockOpMergeBlocks = z.object({
  op: z.literal("merge_blocks"),
  targetId: BlockId,
  sourceId: BlockId,
}) satisfies Codec<T.BlockOpMergeBlocks>;

const BlockOp = z.discriminatedUnion("op", [
  BlockOpInsertBlock,
  BlockOpUpdateText,
  BlockOpSetAttrs,
  BlockOpSetType,
  BlockOpMoveBlock,
  BlockOpDeleteBlock,
  BlockOpRestoreBlock,
  BlockOpSplitBlock,
  BlockOpMergeBlocks,
]) satisfies Codec<T.BlockOp>;

export const BlockSubmit = z.object({
  batchId: z.string(),
  lastSeq: z.number(),
  ops: z.array(BlockOp),
}) satisfies Codec<T.BlockSubmit>;

const BlockOpStatus = z.enum(T.BlockOpStatusValues) satisfies Codec<T.BlockOpStatus>;

export const BlockCreate = z.object({
  type: z.exactOptional(z.string()),
  level: z.exactOptional(z.number()),
  checked: z.exactOptional(z.boolean()),
  language: z.exactOptional(z.string()),
  text: z.string(),
  afterBlock: z.exactOptional(BlockId),
  parentId: z.exactOptional(BlockId),
}) satisfies Codec<T.BlockCreate>;

export const BlockUpdate = z.object({
  block: BlockId,
  baseRev: z.number(),
  text: z.exactOptional(z.string()),
  type: z.exactOptional(z.string()),
  level: z.exactOptional(z.number()),
  checked: z.exactOptional(z.boolean()),
  language: z.exactOptional(z.string()),
}) satisfies Codec<T.BlockUpdate>;

export const BlockDelete = z.object({ block: BlockId }) satisfies Codec<T.BlockDelete>;

export const BlockOpResult = z.object({
  status: BlockOpStatus,
  blockId: BlockId,
  rev: z.exactOptional(z.number()),
  text: z.exactOptional(z.array(TextSpan)),
  yours: z.exactOptional(z.array(TextSpan)),
  reason: z.exactOptional(z.string()),
  suggestion: z.exactOptional(SuggestionId),
}) satisfies Codec<T.BlockOpResult>;

export const BlockAck = z.object({
  batchId: z.string(),
  seq: z.number(),
  results: z.array(BlockOpResult),
  blocks: z.array(Block),
}) satisfies Codec<T.BlockAck>;

export const ArtifactEvent = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Blocks"), seq: z.number(), blocks: z.array(Block) }),
  z.object({ _tag: z.literal("Reset") }),
]) satisfies Codec<T.ArtifactEvent>;

const SuggestionStatus = z.enum(T.SuggestionStatusValues) satisfies Codec<T.SuggestionStatus>;

export const SuggestionChange = z.object({
  text: z.exactOptional(z.array(TextSpan)),
  type: z.exactOptional(BlockType),
  attrs: z.exactOptional(BlockAttrs),
  unset: z.exactOptional(z.array(z.string())),
  delete: z.exactOptional(z.boolean()),
}) satisfies Codec<T.SuggestionChange>;

export const Suggestion = z.object({
  id: SuggestionId,
  artifactId: ArtifactId,
  blockId: BlockId,
  author: z.string(),
  baseRev: z.number(),
  change: SuggestionChange,
  status: SuggestionStatus,
  createdAt: z.number(),
  resolvedAt: z.exactOptional(z.number()),
  resolvedBy: z.exactOptional(z.string()),
}) satisfies Codec<T.Suggestion>;

export const SuggestionCreate = z.object({
  block: BlockId,
  baseRev: z.number(),
  change: SuggestionChange,
}) satisfies Codec<T.SuggestionCreate>;

export const SuggestionEvent = z.object({ _tag: z.literal("Suggestions"), suggestions: z.array(Suggestion) }) satisfies Codec<T.SuggestionEvent>;
