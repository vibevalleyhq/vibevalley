import { z } from "zod";

import type { Codec } from "../codec";
import { ArtifactId, IssueId, SessionId, SuggestionId } from "../common/schema";
import * as T from "./shapes.gen";

export const ArtifactType = z.enum(T.ArtifactTypeValues) satisfies Codec<T.ArtifactType>;

export const ArtifactFileEncoding = z.enum(T.ArtifactFileEncodingValues) satisfies Codec<T.ArtifactFileEncoding>;

export const ArtifactCard = z.object({
  id: ArtifactId,
  title: z.string(),
  artifactType: ArtifactType,
  version: z.number(),
  note: z.string(),
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

export const ArtifactCover = z.object({
  path: z.string(),
  url: z.string(),
  mime: z.string(),
  seq: z.number(),
  width: z.exactOptional(z.number().int().min(1)),
  height: z.exactOptional(z.number().int().min(1)),
  updatedAt: z.number(),
}) satisfies Codec<T.ArtifactCover>;

export const ArtifactCoverSetRequest = z.object({
  id: ArtifactId,
  seq: z.number(),
  mime: z.string(),
  data: z.string(),
  width: z.exactOptional(z.number().int().min(1)),
  height: z.exactOptional(z.number().int().min(1)),
}) satisfies Codec<T.ArtifactCoverSetRequest>;

export const ArtifactPreviewOutlineItem = z.object({
  depth: z.number().int().min(0),
  text: z.string(),
  kind: z.string(),
  checked: z.exactOptional(z.boolean()),
}) satisfies Codec<T.ArtifactPreviewOutlineItem>;

export const ArtifactPreviewSwatch = z.object({
  name: z.string(),
  light: z.string(),
  dark: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactPreviewSwatch>;

export const ArtifactPreviewKpi = z.object({
  label: z.string(),
  value: z.string(),
}) satisfies Codec<T.ArtifactPreviewKpi>;

export const ArtifactPreviewMinimapShape = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  kind: z.string(),
  label: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactPreviewMinimapShape>;

export const ArtifactPreview = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("docs"),
    heading: z.exactOptional(z.string()),
    excerpt: z.string(),
  }),
  z.object({
    _tag: z.literal("outline"),
    items: z.array(ArtifactPreviewOutlineItem),
    todoDone: z.number().int().min(0),
    todoTotal: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("design-system"),
    swatches: z.array(ArtifactPreviewSwatch),
    fonts: z.array(z.string()),
  }),
  z.object({
    _tag: z.literal("dashboard"),
    kpis: z.array(ArtifactPreviewKpi),
    series: z.array(z.number()),
  }),
  z.object({
    _tag: z.literal("sheet"),
    sheetName: z.exactOptional(z.string()),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    totalRows: z.number().int().min(0),
    totalCols: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("slides"),
    firstTitle: z.exactOptional(z.string()),
    firstSubtitle: z.exactOptional(z.string()),
    slideCount: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("whiteboard"),
    shapes: z.array(ArtifactPreviewMinimapShape),
    nodeCount: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("diagram"),
    kind: z.exactOptional(z.string()),
    nodes: z.array(z.string()),
    nodeCount: z.number().int().min(0),
    edgeCount: z.number().int().min(0),
  }),
  z.object({
    _tag: z.literal("design"),
    artboard: z.exactOptional(z.string()),
    width: z.exactOptional(z.number().int().min(1)),
    height: z.exactOptional(z.number().int().min(1)),
    theme: z.exactOptional(z.string()),
    nodes: z.array(z.string()),
    frameAsset: z.exactOptional(z.string()),
    framePath: z.exactOptional(z.string()),
  }),
  z.object({
    _tag: z.literal("storyboard"),
    shotCount: z.number().int().min(0),
    firstShot: z.exactOptional(z.string()),
    durationSec: z.exactOptional(z.number()),
    frameAsset: z.exactOptional(z.string()),
    framePath: z.exactOptional(z.string()),
  }),
  z.object({
    _tag: z.literal("motion"),
    sceneCount: z.number().int().min(0),
    durationSec: z.exactOptional(z.number()),
    firstScene: z.exactOptional(z.string()),
    frameAsset: z.exactOptional(z.string()),
    framePath: z.exactOptional(z.string()),
  }),
  z.object({
    _tag: z.literal("prototype"),
    heading: z.exactOptional(z.string()),
    subtitle: z.exactOptional(z.string()),
  }),
]) satisfies Codec<T.ArtifactPreview>;

export const Artifact = z.object({
  id: ArtifactId,
  title: z.string(),
  artifactType: ArtifactType,
  isDefault: z.boolean(),
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
  preview: z.exactOptional(ArtifactPreview),
  cover: z.exactOptional(ArtifactCover),
}) satisfies Codec<T.Artifact>;

export const ArtifactFileMeta = z.object({
  path: z.string(),
  mime: z.string(),
  size: z.number(),
  hash: z.string(),
  updatedAt: z.number(),
}) satisfies Codec<T.ArtifactFileMeta>;

export const ArtifactFileListRequest = z.object({
  id: ArtifactId,
  prefix: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactFileListRequest>;

export const ArtifactFileListResult = z.object({
  artifactId: ArtifactId,
  seq: z.number(),
  files: z.array(ArtifactFileMeta),
}) satisfies Codec<T.ArtifactFileListResult>;

export const ArtifactFileGetRequest = z.object({
  id: ArtifactId,
  path: z.string(),
  version: z.exactOptional(z.number()),
}) satisfies Codec<T.ArtifactFileGetRequest>;

export const ArtifactFileContent = z.object({
  artifactId: ArtifactId,
  path: z.string(),
  mime: z.string(),
  encoding: ArtifactFileEncoding,
  content: z.string(),
  size: z.number(),
  hash: z.string(),
  updatedAt: z.number(),
}) satisfies Codec<T.ArtifactFileContent>;

export const ArtifactFileWriteItem = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.exactOptional(ArtifactFileEncoding),
  mime: z.exactOptional(z.string()),
  expectedHash: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactFileWriteItem>;

export const ArtifactFileWriteRequest = z.object({
  id: ArtifactId,
  files: z.array(ArtifactFileWriteItem),
  origin: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
  announce: z.exactOptional(z.boolean()),
}) satisfies Codec<T.ArtifactFileWriteRequest>;

export const ArtifactFileDeleteRequest = z.object({
  id: ArtifactId,
  path: z.string(),
  origin: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactFileDeleteRequest>;

export const ArtifactFileDeleteResult = z.object({
  artifactId: ArtifactId,
  seq: z.number(),
  path: z.string(),
  frontiers: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactFileDeleteResult>;

export const ArtifactTypeInfo = z.object({
  type: ArtifactType,
  title: z.string(),
  summary: z.string(),
  entry: z.string(),
  references: z.array(z.string()),
  defaultArtifactId: ArtifactId.nullable(),
}) satisfies Codec<T.ArtifactTypeInfo>;

export const ArtifactTypeReadRequest = z.object({
  type: ArtifactType,
  reference: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactTypeReadRequest>;

export const ArtifactTypeGuide = z.object({
  type: ArtifactType,
  title: z.string(),
  reference: z.string().nullable(),
  content: z.string(),
  references: z.array(z.string()),
  defaultArtifactId: ArtifactId.nullable(),
  defaultArtifactTitle: z.string().nullable(),
}) satisfies Codec<T.ArtifactTypeGuide>;

export const ArtifactViewContext = z.object({
  artifactId: ArtifactId,
  artifactType: ArtifactType,
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
}) satisfies Codec<T.ArtifactViewContext>;

export const ArtifactRequest = z.object({
  title: z.string(),
  artifactType: ArtifactType,
  content: z.exactOptional(z.string()),
  files: z.exactOptional(z.array(ArtifactFileWriteItem)),
  isDefault: z.exactOptional(z.boolean()),
  announce: z.exactOptional(z.boolean()),
  note: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactRequest>;

export const ArtifactVersionRequest = z.object({
  id: ArtifactId,
  content: z.exactOptional(z.string()),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactVersionRequest>;

export const ArtifactUpdateRequest = z.object({
  id: ArtifactId,
  title: z.exactOptional(z.string()),
  isDefault: z.exactOptional(z.boolean()),
  issue: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactUpdateRequest>;

export const ArtifactListRequest = z.object({
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(z.string()),
  artifactType: z.exactOptional(ArtifactType),
}) satisfies Codec<T.ArtifactListRequest>;

export const ArtifactReadRequest = z.object({
  id: ArtifactId,
  version: z.exactOptional(z.number()),
}) satisfies Codec<T.ArtifactReadRequest>;

export const ArtifactContent = z.object({ version: z.number(), content: z.string() }) satisfies Codec<T.ArtifactContent>;

export const ArtifactEvent = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("Files"),
    seq: z.number(),
    files: z.array(ArtifactFileMeta),
    deleted: z.array(z.string()),
    origin: z.exactOptional(z.string()),
    frontiers: z.exactOptional(z.string()),
  }),
  z.object({ _tag: z.literal("Reset") }),
]) satisfies Codec<T.ArtifactEvent>;

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
  artifactId: ArtifactId,
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

export const ArtifactFileWriteResult = z.object({
  artifactId: ArtifactId,
  seq: z.number(),
  files: z.array(ArtifactFileMeta),
  frontiers: z.exactOptional(z.string()),
  suggestions: z.exactOptional(z.array(Suggestion)),
}) satisfies Codec<T.ArtifactFileWriteResult>;

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

export const ArtifactPresenceKind = z.enum(T.ArtifactPresenceKindValues) satisfies Codec<T.ArtifactPresenceKind>;

export const ViewportRect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  zoom: z.exactOptional(z.number()),
}) satisfies Codec<T.ViewportRect>;

export const ArtifactPresence = z.object({
  id: z.string(),
  name: z.string(),
  color: z.exactOptional(z.string()),
  kind: ArtifactPresenceKind,
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
}) satisfies Codec<T.ArtifactPresence>;

export const ArtifactPresenceUpdateRequest = z.object({
  id: ArtifactId,
  presence: z.exactOptional(ArtifactPresence),
  peerId: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactPresenceUpdateRequest>;

export const ArtifactPresenceFollowRequest = z.object({
  id: ArtifactId,
}) satisfies Codec<T.ArtifactPresenceFollowRequest>;

export const ArtifactPresenceEvent = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Snapshot"), peers: z.array(ArtifactPresence) }),
  z.object({ _tag: z.literal("Upsert"), peer: ArtifactPresence }),
  z.object({ _tag: z.literal("Remove"), peerId: z.string() }),
]) satisfies Codec<T.ArtifactPresenceEvent>;

export const ArtifactHistoryEntry = z.object({
  frontiers: z.string(),
  author: z.string(),
  agent: z.exactOptional(z.string()),
  sessionId: z.exactOptional(SessionId),
  turn: z.exactOptional(z.number()),
  origin: z.string(),
  summary: z.exactOptional(z.string()),
  at: z.number(),
}) satisfies Codec<T.ArtifactHistoryEntry>;

export const ArtifactHistoryListRequest = z.object({
  id: ArtifactId,
  limit: z.exactOptional(z.number().int().min(1)),
}) satisfies Codec<T.ArtifactHistoryListRequest>;

export const ArtifactHistoryPreviewRequest = z.object({
  id: ArtifactId,
  frontiers: z.string(),
}) satisfies Codec<T.ArtifactHistoryPreviewRequest>;

export const ArtifactHistoryPreviewResult = z.object({
  artifactId: ArtifactId,
  artifactType: ArtifactType,
  frontiers: z.string(),
  entry: z.exactOptional(ArtifactHistoryEntry),
  files: z.array(ArtifactFileContent),
}) satisfies Codec<T.ArtifactHistoryPreviewResult>;

export const ArtifactHistoryRestoreRequest = z.object({
  id: ArtifactId,
  frontiers: z.string(),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactHistoryRestoreRequest>;

export const ArtifactHistoryForkRequest = z.object({
  id: ArtifactId,
  frontiers: z.string(),
  title: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
}) satisfies Codec<T.ArtifactHistoryForkRequest>;

export const ArtifactHistoryUndoOriginRequest = z.object({
  id: ArtifactId,
  origin: z.string(),
}) satisfies Codec<T.ArtifactHistoryUndoOriginRequest>;

export const ArtifactHistoryCompactRequest = z.object({
  id: ArtifactId,
}) satisfies Codec<T.ArtifactHistoryCompactRequest>;
