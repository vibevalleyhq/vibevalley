import { z } from "zod";

import type { Codec } from "../codec";
import { IssueId, NoteId, SessionId, SuggestionId } from "../common/schema";
import * as T from "./shapes.gen";

export const NoteType = z.enum(T.NoteTypeValues) satisfies Codec<T.NoteType>;

export const NoteFileEncoding = z.enum(T.NoteFileEncodingValues) satisfies Codec<T.NoteFileEncoding>;

export const NoteCard = z.object({
  id: NoteId,
  title: z.string(),
  noteType: NoteType,
  version: z.number(),
  note: z.string(),
}) satisfies Codec<T.NoteCard>;

const NoteVersion = z.object({
  version: z.number(),
  size: z.number(),
  note: z.string(),
  by: z.string(),
  byName: z.string(),
  at: z.number(),
  channel: z.string(),
  number: z.exactOptional(z.number()),
}) satisfies Codec<T.NoteVersion>;

export const NoteCover = z.object({
  path: z.string(),
  url: z.string(),
  mime: z.string(),
  seq: z.number(),
  width: z.exactOptional(z.number().int().min(1)),
  height: z.exactOptional(z.number().int().min(1)),
  updatedAt: z.number(),
}) satisfies Codec<T.NoteCover>;

export const NoteCoverSetRequest = z.object({
  id: NoteId,
  seq: z.number(),
  mime: z.string(),
  data: z.string(),
  width: z.exactOptional(z.number().int().min(1)),
  height: z.exactOptional(z.number().int().min(1)),
}) satisfies Codec<T.NoteCoverSetRequest>;

export const NotePreviewOutlineItem = z.object({
  depth: z.number().int().min(0),
  text: z.string(),
  kind: z.string(),
  checked: z.exactOptional(z.boolean()),
}) satisfies Codec<T.NotePreviewOutlineItem>;

export const NotePreviewSwatch = z.object({
  name: z.string(),
  light: z.string(),
  dark: z.exactOptional(z.string()),
}) satisfies Codec<T.NotePreviewSwatch>;

export const NotePreviewKpi = z.object({
  label: z.string(),
  value: z.string(),
}) satisfies Codec<T.NotePreviewKpi>;

export const NotePreviewMinimapShape = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  kind: z.string(),
  label: z.exactOptional(z.string()),
}) satisfies Codec<T.NotePreviewMinimapShape>;

export const NotePreview = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("doc"),
    heading: z.exactOptional(z.string()),
    excerpt: z.string(),
    blockCount: z.number().int().min(0),
    slideCount: z.number().int().min(0),
    outline: z.array(NotePreviewOutlineItem),
  }),
  z.object({
    _tag: z.literal("base"),
    sheetName: z.exactOptional(z.string()),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    totalRows: z.number().int().min(0),
    totalCols: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("canvas"),
    shapes: z.array(NotePreviewMinimapShape),
    nodeCount: z.number().int().min(0),
    theme: z.exactOptional(z.string()),
  }),
  z.object({
    _tag: z.literal("media"),
    mediaKind: z.string(),
    caption: z.exactOptional(z.string()),
    durationSec: z.exactOptional(z.number()),
    frameAsset: z.exactOptional(z.string()),
    framePath: z.exactOptional(z.string()),
  }),
]) satisfies Codec<T.NotePreview>;

export const Note = z.object({
  id: NoteId,
  title: z.string(),
  noteType: NoteType,
  parentId: z.exactOptional(NoteId),
  sortOrder: z.number(),
  channel: z.exactOptional(z.string()),
  said: z.exactOptional(z.object({ channel: z.string(), number: z.number() })),
  issue: z.exactOptional(IssueId),
  by: z.string(),
  byName: z.string(),
  version: z.number(),
  seq: z.number(),
  versions: z.array(NoteVersion),
  at: z.number(),
  updated: z.number(),
  preview: z.exactOptional(NotePreview),
  cover: z.exactOptional(NoteCover),
}) satisfies Codec<T.Note>;

export const NoteFileMeta = z.object({
  path: z.string(),
  mime: z.string(),
  size: z.number(),
  hash: z.string(),
  updatedAt: z.number(),
}) satisfies Codec<T.NoteFileMeta>;

export const NoteFileListRequest = z.object({
  id: NoteId,
  prefix: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteFileListRequest>;

export const NoteFileListResult = z.object({
  noteId: NoteId,
  seq: z.number(),
  files: z.array(NoteFileMeta),
}) satisfies Codec<T.NoteFileListResult>;

export const NoteFileGetRequest = z.object({
  id: NoteId,
  path: z.string(),
  version: z.exactOptional(z.number()),
}) satisfies Codec<T.NoteFileGetRequest>;

export const NoteFileContent = z.object({
  noteId: NoteId,
  path: z.string(),
  mime: z.string(),
  encoding: NoteFileEncoding,
  content: z.string(),
  size: z.number(),
  hash: z.string(),
  updatedAt: z.number(),
}) satisfies Codec<T.NoteFileContent>;

export const NoteFileWriteItem = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.exactOptional(NoteFileEncoding),
  mime: z.exactOptional(z.string()),
  expectedHash: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteFileWriteItem>;

export const NoteFileWriteRequest = z.object({
  id: NoteId,
  files: z.array(NoteFileWriteItem),
  origin: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
  announce: z.exactOptional(z.boolean()),
}) satisfies Codec<T.NoteFileWriteRequest>;

export const NoteFileDeleteRequest = z.object({
  id: NoteId,
  path: z.string(),
  origin: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteFileDeleteRequest>;

export const NoteFileDeleteResult = z.object({
  noteId: NoteId,
  seq: z.number(),
  path: z.string(),
  frontiers: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteFileDeleteResult>;

export const NoteTypeInfo = z.object({
  type: NoteType,
  title: z.string(),
  summary: z.string(),
  entry: z.string(),
  references: z.array(z.string()),
}) satisfies Codec<T.NoteTypeInfo>;

export const NoteTypeReadRequest = z.object({
  type: NoteType,
  reference: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteTypeReadRequest>;

export const NoteTypeGuide = z.object({
  type: NoteType,
  title: z.string(),
  reference: z.string().nullable(),
  content: z.string(),
  references: z.array(z.string()),
}) satisfies Codec<T.NoteTypeGuide>;

export const NoteViewContext = z.object({
  noteId: NoteId,
  noteType: NoteType,
  title: z.string().max(500),
  seq: z.exactOptional(z.number().int().min(0)),
  version: z.exactOptional(z.number().int().min(0)),
  activePath: z.exactOptional(z.string().max(240)),
  slideId: z.exactOptional(z.string().max(200)),
  slideIndex: z.exactOptional(z.number().int().min(0)),
  time: z.exactOptional(z.number().min(0)),
  activeArtboard: z.exactOptional(z.string().max(200)),
  activeDataset: z.exactOptional(z.string().max(200)),
  activeTab: z.exactOptional(z.string().max(100)),
  selectedIds: z.exactOptional(z.array(z.string().max(200)).max(100)),
  summary: z.exactOptional(z.string().max(2000)),
}) satisfies Codec<T.NoteViewContext>;

export const NoteRequest = z.object({
  title: z.string(),
  noteType: NoteType,
  parentId: z.exactOptional(NoteId),
  sortOrder: z.exactOptional(z.number()),
  content: z.exactOptional(z.string()),
  files: z.exactOptional(z.array(NoteFileWriteItem)),
  announce: z.exactOptional(z.boolean()),
  note: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteRequest>;

export const NoteVersionRequest = z.object({
  id: NoteId,
  content: z.exactOptional(z.string()),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteVersionRequest>;

export const NoteUpdateRequest = z.object({
  id: NoteId,
  title: z.exactOptional(z.string()),
  parentId: z.exactOptional(z.string()),
  sortOrder: z.exactOptional(z.number()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteUpdateRequest>;

export const NoteListRequest = z.object({
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
  noteType: z.exactOptional(NoteType),
  parentId: z.exactOptional(NoteId),
}) satisfies Codec<T.NoteListRequest>;

export const NoteReadRequest = z.object({
  id: NoteId,
  version: z.exactOptional(z.number()),
}) satisfies Codec<T.NoteReadRequest>;

export const NoteContent = z.object({ version: z.number(), content: z.string() }) satisfies Codec<T.NoteContent>;

export const NoteEvent = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Files"),
    seq: z.number(),
    files: z.array(NoteFileMeta),
    deleted: z.array(z.string()),
    origin: z.exactOptional(z.string()),
    frontiers: z.exactOptional(z.string()),
  }),
  z.object({ _tag: z.literal("Reset") }),
]) satisfies Codec<T.NoteEvent>;

const SuggestionStatus = z.enum(T.SuggestionStatusValues) satisfies Codec<T.SuggestionStatus>;

export const SuggestionChange = z.object({
  content: z.exactOptional(z.string()),
  patch: z.exactOptional(z.string()),
  target: z.exactOptional(z.string()),
  delete: z.exactOptional(z.boolean()),
  summary: z.exactOptional(z.string()),
}) satisfies Codec<T.SuggestionChange>;

export const Suggestion = z.object({
  id: SuggestionId,
  noteId: NoteId,
  path: z.string(),
  author: z.string(),
  baseRev: z.number(),
  baseHash: z.exactOptional(z.string()),
  change: SuggestionChange,
  status: SuggestionStatus,
  createdAt: z.number(),
  resolvedAt: z.exactOptional(z.number()),
  resolvedBy: z.exactOptional(z.string()),
  cursorStart: z.exactOptional(z.string()),
  cursorEnd: z.exactOptional(z.string()),
  startOffset: z.exactOptional(z.number().int().min(0)),
  endOffset: z.exactOptional(z.number().int().min(0)),
}) satisfies Codec<T.Suggestion>;

export const NoteFileWriteResult = z.object({
  noteId: NoteId,
  seq: z.number(),
  files: z.array(NoteFileMeta),
  frontiers: z.exactOptional(z.string()),
  suggestions: z.exactOptional(z.array(Suggestion)),
}) satisfies Codec<T.NoteFileWriteResult>;

export const SuggestionCreate = z.object({
  path: z.string(),
  baseRev: z.number(),
  baseHash: z.exactOptional(z.string()),
  change: SuggestionChange,
  cursorStart: z.exactOptional(z.string()),
  cursorEnd: z.exactOptional(z.string()),
  startOffset: z.exactOptional(z.number().int().min(0)),
  endOffset: z.exactOptional(z.number().int().min(0)),
}) satisfies Codec<T.SuggestionCreate>;

export const SuggestionEvent = z.object({ _tag: z.literal("Suggestions"), suggestions: z.array(Suggestion) }) satisfies Codec<T.SuggestionEvent>;

export const NotePresenceKind = z.enum(T.NotePresenceKindValues) satisfies Codec<T.NotePresenceKind>;

export const ViewportRect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  zoom: z.exactOptional(z.number()),
}) satisfies Codec<T.ViewportRect>;

export const NotePresence = z.object({
  id: z.string(),
  name: z.string(),
  color: z.exactOptional(z.string()),
  kind: NotePresenceKind,
  x: z.exactOptional(z.number()),
  y: z.exactOptional(z.number()),
  w: z.exactOptional(z.number()),
  h: z.exactOptional(z.number()),
  status: z.exactOptional(z.string()),
  nodeId: z.exactOptional(z.string()),
  offset: z.exactOptional(z.number().int().min(0)),
  endOffset: z.exactOptional(z.number().int().min(0)),
  selector: z.exactOptional(z.string()),
  path: z.exactOptional(z.string()),
  viewport: z.exactOptional(ViewportRect),
  sessionId: z.exactOptional(SessionId),
  updatedAt: z.number(),
}) satisfies Codec<T.NotePresence>;

export const NotePresenceUpdateRequest = z.object({
  id: NoteId,
  presence: z.exactOptional(NotePresence),
  peerId: z.exactOptional(z.string()),
}) satisfies Codec<T.NotePresenceUpdateRequest>;

export const NotePresenceFollowRequest = z.object({
  id: NoteId,
}) satisfies Codec<T.NotePresenceFollowRequest>;

export const NotePresenceEvent = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Snapshot"), peers: z.array(NotePresence) }),
  z.object({ _tag: z.literal("Upsert"), peer: NotePresence }),
  z.object({ _tag: z.literal("Remove"), peerId: z.string() }),
]) satisfies Codec<T.NotePresenceEvent>;

export const NoteHistoryEntry = z.object({
  frontiers: z.string(),
  author: z.string(),
  agent: z.exactOptional(z.string()),
  sessionId: z.exactOptional(SessionId),
  turn: z.exactOptional(z.number()),
  origin: z.string(),
  summary: z.exactOptional(z.string()),
  at: z.number(),
}) satisfies Codec<T.NoteHistoryEntry>;

export const NoteHistoryListRequest = z.object({
  id: NoteId,
  limit: z.exactOptional(z.number().int().min(1)),
}) satisfies Codec<T.NoteHistoryListRequest>;

export const NoteHistoryPreviewRequest = z.object({
  id: NoteId,
  frontiers: z.string(),
}) satisfies Codec<T.NoteHistoryPreviewRequest>;

export const NoteHistoryPreviewResult = z.object({
  noteId: NoteId,
  noteType: NoteType,
  frontiers: z.string(),
  entry: z.exactOptional(NoteHistoryEntry),
  files: z.array(NoteFileContent),
}) satisfies Codec<T.NoteHistoryPreviewResult>;

export const NoteHistoryRestoreRequest = z.object({
  id: NoteId,
  frontiers: z.string(),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteHistoryRestoreRequest>;

export const NoteHistoryForkRequest = z.object({
  id: NoteId,
  frontiers: z.string(),
  title: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteHistoryForkRequest>;

export const NoteHistoryUndoOriginRequest = z.object({
  id: NoteId,
  origin: z.string(),
}) satisfies Codec<T.NoteHistoryUndoOriginRequest>;

export const NoteHistoryCompactRequest = z.object({
  id: NoteId,
}) satisfies Codec<T.NoteHistoryCompactRequest>;

export const NoteCollabExportRequest = z.object({
  id: NoteId,
  versionVector: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteCollabExportRequest>;

export const NoteCollabExportResult = z.object({
  noteId: NoteId,
  seq: z.number(),
  versionVector: z.string(),
  frontiers: z.string(),
  snapshot: z.boolean(),
  update: z.string(),
}) satisfies Codec<T.NoteCollabExportResult>;

export const NoteCollabImportRequest = z.object({
  id: NoteId,
  update: z.string(),
  clientVersionVector: z.exactOptional(z.string()),
  origin: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteCollabImportRequest>;

export const NoteCollabImportResult = z.object({
  noteId: NoteId,
  seq: z.number(),
  versionVector: z.string(),
  frontiers: z.string(),
  files: z.array(NoteFileMeta),
  deleted: z.array(z.string()),
  serverUpdate: z.exactOptional(z.string()),
  serverSnapshot: z.exactOptional(z.boolean()),
}) satisfies Codec<T.NoteCollabImportResult>;

export const LinkEntityKind = z.enum(T.LinkEntityKindValues) satisfies Codec<T.LinkEntityKind>;

export const LinkRelation = z.enum(T.LinkRelationValues) satisfies Codec<T.LinkRelation>;

export const NoteLinkRef = z.object({
  kind: LinkEntityKind,
  id: z.string(),
  relation: LinkRelation,
  title: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteLinkRef>;

export const NoteTreeMoveRequest = z.object({
  id: NoteId,
  parentId: z.exactOptional(NoteId),
  sortOrder: z.number().int(),
}) satisfies Codec<T.NoteTreeMoveRequest>;

export const NoteLink = z.object({
  id: z.string(),
  sourceKind: LinkEntityKind,
  sourceId: z.string(),
  targetKind: LinkEntityKind,
  targetId: z.string(),
  relation: LinkRelation,
  title: z.exactOptional(z.string()),
  noteType: z.exactOptional(NoteType),
  createdAt: z.number(),
}) satisfies Codec<T.NoteLink>;

export const NoteLinkListRequest = z.object({
  entityKind: LinkEntityKind,
  entityId: z.string(),
}) satisfies Codec<T.NoteLinkListRequest>;

export const NoteLinkListResult = z.object({
  outgoing: z.array(NoteLink),
  backlinks: z.array(NoteLink),
}) satisfies Codec<T.NoteLinkListResult>;

export const MediaAnnotationKind = z.enum(T.MediaAnnotationKindValues) satisfies Codec<T.MediaAnnotationKind>;

export const MediaAnnotationSeverity = z.enum(T.MediaAnnotationSeverityValues) satisfies Codec<T.MediaAnnotationSeverity>;

export const MediaAnnotationStatus = z.enum(T.MediaAnnotationStatusValues) satisfies Codec<T.MediaAnnotationStatus>;

export const MediaAnnotationSide = z.enum(T.MediaAnnotationSideValues) satisfies Codec<T.MediaAnnotationSide>;

export const MediaAnnotationRect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
}) satisfies Codec<T.MediaAnnotationRect>;

export const MediaAnnotationPoint = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}) satisfies Codec<T.MediaAnnotationPoint>;

export const MediaAnnotation = z.object({
  id: z.string(),
  number: z.number().int().min(0),
  kind: z.exactOptional(MediaAnnotationKind),
  rect: MediaAnnotationRect,
  to: z.exactOptional(MediaAnnotationPoint),
  side: z.exactOptional(MediaAnnotationSide),
  severity: MediaAnnotationSeverity,
  title: z.string(),
  body: z.exactOptional(z.string()),
  status: MediaAnnotationStatus,
  issueId: z.exactOptional(IssueId),
  baseRowId: z.exactOptional(z.string()),
  author: z.exactOptional(z.string()),
  createdAt: z.exactOptional(z.number()),
  updatedAt: z.exactOptional(z.number()),
}) satisfies Codec<T.MediaAnnotation>;

export const MediaAnnotationSummary = z.object({
  total: z.number().int().min(0),
  open: z.number().int().min(0),
  resolved: z.number().int().min(0),
  p0: z.number().int().min(0),
  p1: z.number().int().min(0),
  p2: z.number().int().min(0),
  ux: z.number().int().min(0),
  linkedRows: z.number().int().min(0),
  linkedIssues: z.number().int().min(0),
}) satisfies Codec<T.MediaAnnotationSummary>;

export const BaseAnnotationRef = z.object({
  noteId: NoteId,
  blockId: z.string(),
  annotationId: z.string(),
  number: z.exactOptional(z.number().int().min(0)),
}) satisfies Codec<T.BaseAnnotationRef>;

export const ReviewSyncDirection = z.enum(T.ReviewSyncDirectionValues) satisfies Codec<T.ReviewSyncDirection>;

export const NoteAnnotationUpsertRequest = z.object({
  id: NoteId,
  blockId: z.exactOptional(z.string()),
  annotation: MediaAnnotation,
  baseNoteId: z.exactOptional(NoteId),
  baseSheetId: z.exactOptional(z.string()),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteAnnotationUpsertRequest>;

export const NoteAnnotationDeleteRequest = z.object({
  id: NoteId,
  blockId: z.exactOptional(z.string()),
  annotationId: z.string(),
  baseNoteId: z.exactOptional(NoteId),
  baseSheetId: z.exactOptional(z.string()),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteAnnotationDeleteRequest>;

export const NoteAnnotationMutationResult = z.object({
  noteId: NoteId,
  blockId: z.exactOptional(z.string()),
  annotations: z.array(MediaAnnotation),
  summary: MediaAnnotationSummary,
  syncedBaseNoteId: z.exactOptional(NoteId),
  syncedBaseRowId: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteAnnotationMutationResult>;

export const NoteReviewSyncRequest = z.object({
  id: NoteId,
  baseNoteId: z.exactOptional(NoteId),
  sheetId: z.exactOptional(z.string()),
  spawnIssueRepo: z.exactOptional(z.string()),
  direction: z.exactOptional(ReviewSyncDirection),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteReviewSyncRequest>;

export const DocKpiItem = z.object({
  label: z.string(),
  value: z.string(),
  delta: z.exactOptional(z.string()),
  tone: z.exactOptional(z.string()),
}) satisfies Codec<T.DocKpiItem>;

export const DocChartSeries = z.object({
  name: z.string(),
  data: z.array(z.number()),
}) satisfies Codec<T.DocChartSeries>;

export const DocColumn: Codec<T.DocColumn> = z.lazy(() => z.object({ blocks: z.array(DocBlock) }));

const BlockKind: Codec<T.BlockKind> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prose"), text: z.string() }),
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("todo"), checked: z.boolean(), text: z.string() }),
  z.object({ type: z.literal("callout"), tone: z.string(), title: z.exactOptional(z.string()), text: z.string() }),
  z.object({ type: z.literal("code"), language: z.exactOptional(z.string()), code: z.string() }),
  z.object({ type: z.literal("kpi"), items: z.array(DocKpiItem) }),
  z.object({
    type: z.literal("chart"),
    title: z.exactOptional(z.string()),
    kind: z.string(),
    labels: z.array(z.string()),
    series: z.array(DocChartSeries),
  }),
  z.object({ type: z.literal("diagram"), title: z.exactOptional(z.string()), source: z.string() }),
  z.object({
    type: z.literal("compare"),
    title: z.exactOptional(z.string()),
    beforeLabel: z.string(),
    afterLabel: z.string(),
    beforeAsset: z.string(),
    afterAsset: z.string(),
    annotations: z.exactOptional(z.array(MediaAnnotation)),
  }),
  z.object({
    type: z.literal("media"),
    mediaKind: z.string(),
    src: z.string(),
    caption: z.exactOptional(z.string()),
    annotations: z.exactOptional(z.array(MediaAnnotation)),
  }),
  z.object({ type: z.literal("preview"), entry: z.string(), height: z.exactOptional(z.number()), title: z.exactOptional(z.string()) }),
  z.object({
    type: z.literal("baseEmbed"),
    noteId: NoteId,
    sheetId: z.exactOptional(z.string()),
    viewId: z.exactOptional(z.string()),
  }),
  z.object({ type: z.literal("issueCard"), issueId: IssueId }),
  z.object({
    type: z.literal("issueList"),
    repo: z.exactOptional(z.string()),
    status: z.exactOptional(z.string()),
    tag: z.exactOptional(z.string()),
    limit: z.exactOptional(z.number()),
  }),
  z.object({ type: z.literal("columns"), columns: z.array(DocColumn) }),
  z.object({ type: z.literal("pageBreak"), title: z.exactOptional(z.string()), speakerNotes: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("divider") }),
  z.object({ type: z.literal("quote"), text: z.string(), attribution: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("toggle"), title: z.string(), text: z.string() }),
  z.object({
    type: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    alignments: z.exactOptional(z.array(z.string())),
    columnWidths: z.exactOptional(z.array(z.number().int().min(1))),
  }),
  z.object({
    type: z.literal("bookmark"),
    url: z.string(),
    title: z.exactOptional(z.string()),
    description: z.exactOptional(z.string()),
  }),
  z.object({ type: z.literal("toc"), maxLevel: z.exactOptional(z.number().int().min(1).max(6)) }),
  z.object({ type: z.literal("math"), expression: z.string(), display: z.exactOptional(z.boolean()) }),
]);

export const DocBlock: Codec<T.DocBlock> = z.lazy(() =>
  z.intersection(
    z.object({
      id: z.string(),
      collapsed: z.exactOptional(z.boolean()),
      children: z.exactOptional(z.array(DocBlock)),
    }),
    BlockKind,
  ),
);

export const DocView = z.object({
  noteId: NoteId,
  title: z.string(),
  blocks: z.array(DocBlock),
  slideCount: z.number().int().min(0),
  wordCount: z.number().int().min(0),
  extractedLinks: z.array(NoteLinkRef),
  annotationSummary: z.exactOptional(MediaAnnotationSummary),
}) satisfies Codec<T.DocView>;

export const NoteDocViewRequest = z.object({
  id: NoteId,
}) satisfies Codec<T.NoteDocViewRequest>;

export const NoteDocAppendBlockRequest = z.object({
  id: NoteId,
  block: DocBlock,
  afterBlockId: z.exactOptional(z.string()),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.NoteDocAppendBlockRequest>;

export const BaseColumnKind = z.enum(T.BaseColumnKindValues) satisfies Codec<T.BaseColumnKind>;

export const BaseViewKind = z.enum(T.BaseViewKindValues) satisfies Codec<T.BaseViewKind>;

export const BaseSummaryOp = z.enum(T.BaseSummaryOpValues) satisfies Codec<T.BaseSummaryOp>;

export const BaseFilterOp = z.enum(T.BaseFilterOpValues) satisfies Codec<T.BaseFilterOp>;

export const BaseSelectOption = z.object({
  value: z.string(),
  label: z.exactOptional(z.string()),
  color: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseSelectOption>;

export const BaseAgentColumnConfig = z.object({
  agentId: z.exactOptional(z.string()),
  promptTemplate: z.string(),
  targetColumnId: z.exactOptional(z.string()),
  spawnIssueRepo: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseAgentColumnConfig>;

export const BaseColumn = z.object({
  id: z.string(),
  name: z.string(),
  kind: BaseColumnKind,
  options: z.exactOptional(z.array(BaseSelectOption)),
  agentConfig: z.exactOptional(BaseAgentColumnConfig),
  formula: z.exactOptional(z.string()),
  width: z.exactOptional(z.number()),
}) satisfies Codec<T.BaseColumn>;

export const BaseCellValue = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("text"), value: z.string() }),
  z.object({ _tag: z.literal("number"), value: z.number() }),
  z.object({ _tag: z.literal("bool"), value: z.boolean() }),
  z.object({ _tag: z.literal("strings"), items: z.array(z.string()) }),
  z.object({ _tag: z.literal("issueRef"), issueId: IssueId }),
  z.object({ _tag: z.literal("noteRef"), noteId: NoteId }),
  z.object({ _tag: z.literal("agentRef"), agentId: z.string() }),
  z.object({
    _tag: z.literal("agentRun"),
    status: z.string(),
    summary: z.exactOptional(z.string()),
    sessionId: z.exactOptional(SessionId),
    spawnedIssueId: z.exactOptional(IssueId),
    updatedAt: z.number(),
  }),
]) satisfies Codec<T.BaseCellValue>;

export const BaseRow = z.object({
  id: z.string(),
  cells: z.record(z.string(), BaseCellValue),
  pageNoteId: z.exactOptional(NoteId),
  annotationRef: z.exactOptional(BaseAnnotationRef),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies Codec<T.BaseRow>;

export const BaseFilterRule = z.object({
  columnId: z.string(),
  op: BaseFilterOp,
  value: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseFilterRule>;

export const BaseSortRule = z.object({
  columnId: z.string(),
  desc: z.boolean(),
}) satisfies Codec<T.BaseSortRule>;

export const BaseSummaryConfig = z.object({
  columnId: z.string(),
  op: BaseSummaryOp,
}) satisfies Codec<T.BaseSummaryConfig>;

export const BaseViewConfig = z.object({
  id: z.string(),
  name: z.string(),
  kind: BaseViewKind,
  groupBy: z.exactOptional(z.string()),
  hiddenColumns: z.exactOptional(z.array(z.string())),
  filters: z.exactOptional(z.array(BaseFilterRule)),
  sorts: z.exactOptional(z.array(BaseSortRule)),
  summaries: z.exactOptional(z.array(BaseSummaryConfig)),
}) satisfies Codec<T.BaseViewConfig>;

export const BaseSheetMeta = z.object({
  id: z.string(),
  name: z.string(),
  rowCount: z.number().int().min(0),
}) satisfies Codec<T.BaseSheetMeta>;

export const BaseGroupSnapshot = z.object({
  key: z.string(),
  label: z.string(),
  rowIds: z.array(z.string()),
  count: z.number().int().min(0),
}) satisfies Codec<T.BaseGroupSnapshot>;

export const BaseSummaryResult = z.object({
  columnId: z.string(),
  op: BaseSummaryOp,
  value: z.string(),
}) satisfies Codec<T.BaseSummaryResult>;

export const BaseViewRequest = z.object({
  id: NoteId,
  sheetId: z.exactOptional(z.string()),
  viewId: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseViewRequest>;

export const BaseViewSnapshot = z.object({
  noteId: NoteId,
  sheets: z.array(BaseSheetMeta),
  activeSheetId: z.string(),
  activeViewId: z.string(),
  activeViewKind: BaseViewKind,
  columns: z.array(BaseColumn),
  rows: z.array(BaseRow),
  groups: z.array(BaseGroupSnapshot),
  summaries: z.array(BaseSummaryResult),
  totalRows: z.number().int().min(0),
}) satisfies Codec<T.BaseViewSnapshot>;

export const BaseUpsertRowRequest = z.object({
  id: NoteId,
  sheetId: z.exactOptional(z.string()),
  rowId: z.exactOptional(z.string()),
  cells: z.record(z.string(), BaseCellValue),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseUpsertRowRequest>;

export const BaseRunAgentColumnRequest = z.object({
  id: NoteId,
  sheetId: z.exactOptional(z.string()),
  columnId: z.string(),
  rowIds: z.exactOptional(z.array(z.string())),
  origin: z.exactOptional(z.string()),
}) satisfies Codec<T.BaseRunAgentColumnRequest>;

export const BaseRunAgentColumnResult = z.object({
  noteId: NoteId,
  sheetId: z.string(),
  columnId: z.string(),
  executed: z.number().int().min(0),
  updatedRowIds: z.array(z.string()),
  spawnedIssueIds: z.array(z.string()),
}) satisfies Codec<T.BaseRunAgentColumnResult>;

export const NoteReviewSyncResult = z.object({
  docNoteId: NoteId,
  baseNoteId: NoteId,
  sheetId: z.string(),
  createdBase: z.boolean(),
  linkedCount: z.number().int().min(0),
  updatedAnnotations: z.number().int().min(0),
  updatedRows: z.number().int().min(0),
  summary: MediaAnnotationSummary,
  baseSnapshot: BaseViewSnapshot,
}) satisfies Codec<T.NoteReviewSyncResult>;
