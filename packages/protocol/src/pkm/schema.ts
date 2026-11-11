import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";
import { PkmMoveAtValues, PkmMoveDirectionValues } from "./shapes";

const pkmProps = z.record(z.string(), z.string());
const PkmTier = z.enum(T.PkmTierValues) satisfies Codec<T.PkmTier>;
const PkmMarker = z.enum(T.PkmMarkerValues) satisfies Codec<T.PkmMarker>;
const PkmPriority = z.enum(T.PkmPriorityValues) satisfies Codec<T.PkmPriority>;

const PkmBlock = z.object({
  id: z.string(),
  parent: z.exactOptional(z.string()),
  depth: z.number().int(),
  marker: z.exactOptional(PkmMarker),
  priority: z.exactOptional(PkmPriority),
  body: z.string(),
  props: pkmProps,
  path: z.string(),
}) satisfies Codec<T.PkmBlock>;

const PkmPageSummary = z.object({
  slug: z.string(),
  title: z.string(),
  tier: PkmTier,
  file: z.string(),
  tldr: z.string(),
  updated: z.number(),
  open: z.number().int(),
  day: z.exactOptional(z.string()),
}) satisfies Codec<T.PkmPageSummary>;

export const PkmVault = z.object({
  root: z.string(),
  pages: z.array(PkmPageSummary),
}) satisfies Codec<T.PkmVault>;

export const PkmPage = z.object({
  slug: z.string(),
  title: z.string(),
  tier: PkmTier,
  file: z.string(),
  props: pkmProps,
  tldr: z.string(),
  blocks: z.array(PkmBlock),
  updated: z.number(),
}) satisfies Codec<T.PkmPage>;

const PkmTransclusion = z.object({
  block: z.string(),
  found: z.boolean(),
  circular: z.boolean(),
  page: z.exactOptional(z.string()),
  pageTitle: z.exactOptional(z.string()),
  body: z.string(),
}) satisfies Codec<T.PkmTransclusion>;

const PkmBacklink = z.object({
  block: z.string(),
  page: z.string(),
  pageTitle: z.string(),
  tier: PkmTier,
  path: z.string(),
  body: z.string(),
}) satisfies Codec<T.PkmBacklink>;

const pkmBacklinks = z.array(PkmBacklink);
const PkmBacklinks = z.object({
  projects: pkmBacklinks,
  journals: pkmBacklinks,
  areas: pkmBacklinks,
  archives: pkmBacklinks,
}) satisfies Codec<T.PkmBacklinks>;

export const PkmComment = z.object({
  id: z.string(),
  page: z.string(),
  block: z.string(),
  span: z.exactOptional(z.string()),
  by: z.string(),
  body: z.string(),
  status: z.enum(T.PkmCommentStatusValues),
  suggested: z.exactOptional(z.string()),
  rationale: z.exactOptional(z.string()),
  created: z.number(),
  resolved: z.exactOptional(z.number()),
}) satisfies Codec<T.PkmComment>;

export const PkmPageView = z.object({
  page: PkmPage,
  transclusions: z.array(PkmTransclusion),
  backlinks: PkmBacklinks,
  comments: z.array(PkmComment),
}) satisfies Codec<T.PkmPageView>;

export const PkmPageRequest = z.object({
  title: z.string(),
  tier: z.exactOptional(PkmTier),
  props: z.exactOptional(pkmProps),
  markdown: z.exactOptional(z.string()),
}) satisfies Codec<T.PkmPageRequest>;

export const PkmPageRef = z.object({ page: z.string() }) satisfies Codec<T.PkmPageRef>;

export const PkmMoveRequest = z.object({ page: z.string(), tier: PkmTier }) satisfies Codec<T.PkmMoveRequest>;

const pkmNewBlock = {
  id: z.exactOptional(z.string()),
  body: z.string(),
  marker: z.exactOptional(PkmMarker),
  priority: z.exactOptional(PkmPriority),
  props: z.exactOptional(pkmProps),
};
const pkmOn = { block: z.string() };
const PkmBlockOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), ...pkmNewBlock }),
  z.object({ op: z.literal("insert_before"), ...pkmOn, ...pkmNewBlock }),
  z.object({ op: z.literal("insert_after"), ...pkmOn, ...pkmNewBlock }),
  z.object({ op: z.literal("insert_child"), ...pkmOn, ...pkmNewBlock }),
  z.object({
    op: z.literal("update"),
    ...pkmOn,
    body: z.exactOptional(z.string()),
    priority: z.exactOptional(PkmPriority),
    props: z.exactOptional(pkmProps),
  }),
  z.object({ op: z.literal("set_marker"), ...pkmOn, marker: z.exactOptional(PkmMarker) }),
  z.object({ op: z.literal("toggle_marker"), ...pkmOn }),
  z.object({ op: z.literal("delete"), ...pkmOn }),
  z.object({ op: z.literal("indent"), ...pkmOn }),
  z.object({ op: z.literal("outdent"), ...pkmOn }),
  z.object({ op: z.literal("move"), ...pkmOn, direction: z.enum(PkmMoveDirectionValues) }),
  z.object({ op: z.literal("move_to"), ...pkmOn, target: z.string(), at: z.enum(PkmMoveAtValues) }),
]) satisfies Codec<T.PkmBlockOp>;

export const PkmMutation = z.object({ page: z.string(), ops: z.array(PkmBlockOp) }) satisfies Codec<T.PkmMutation>;

export const PkmSearchRequest = z.object({
  text: z.exactOptional(z.string()),
  tier: z.exactOptional(PkmTier),
  marker: z.exactOptional(PkmMarker),
  linkedTo: z.exactOptional(z.string()),
  limit: z.exactOptional(z.number().int()),
}) satisfies Codec<T.PkmSearchRequest>;

export const PkmSearchHit = z.object({
  block: z.string(),
  page: z.string(),
  pageTitle: z.string(),
  tier: PkmTier,
  marker: z.exactOptional(PkmMarker),
  path: z.string(),
  body: z.string(),
  plain: z.string(),
  score: z.number(),
  children: z.array(PkmBlock),
}) satisfies Codec<T.PkmSearchHit>;

export const PkmCaptureRequest = z.object({ text: z.string(), page: z.exactOptional(z.string()) }) satisfies Codec<T.PkmCaptureRequest>;

export const PkmSource = z.object({ page: z.string(), title: z.string(), markdown: z.string(), updated: z.number() }) satisfies Codec<T.PkmSource>;

export const PkmSourceUpdate = z.object({ page: z.string(), markdown: z.string(), updated: z.number() }) satisfies Codec<T.PkmSourceUpdate>;

export const PkmJournalRequest = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }) satisfies Codec<T.PkmJournalRequest>;

const PkmStaleProject = z.object({
  slug: z.string(),
  title: z.string(),
  days: z.number().int(),
  deadline: z.exactOptional(z.string()),
  todo: z.number().int(),
  doing: z.number().int(),
  done: z.number().int(),
}) satisfies Codec<T.PkmStaleProject>;

const PkmOverdue = z.object({
  block: z.string(),
  page: z.string(),
  body: z.string(),
  plain: z.string(),
  deadline: z.string(),
}) satisfies Codec<T.PkmOverdue>;

export const PkmRadar = z.object({
  inbox: z.number().int(),
  stale: z.array(PkmStaleProject),
  overdue: z.array(PkmOverdue),
}) satisfies Codec<T.PkmRadar>;

export const PkmProposalRequest = z.object({
  block: z.string(),
  suggested: z.string(),
  rationale: z.exactOptional(z.string()),
  comment: z.exactOptional(z.string()),
}) satisfies Codec<T.PkmProposalRequest>;

export const PkmProposal = z.object({
  comment: PkmComment,
  kept: z.array(z.string()),
  restored: z.array(z.string()),
}) satisfies Codec<T.PkmProposal>;

export const PkmResolveRequest = z.object({ id: z.string(), accept: z.boolean() }) satisfies Codec<T.PkmResolveRequest>;

export const PkmClipRequest = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  author: z.exactOptional(z.string()),
  tldr: z.exactOptional(z.string()),
  highlights: z.exactOptional(z.array(z.object({ text: z.string(), anchor: z.string() }))),
  tags: z.exactOptional(z.array(z.string())),
  tier: z.exactOptional(PkmTier),
}) satisfies Codec<T.PkmClipRequest>;

export const PkmClip = z.object({ duplicate: z.boolean(), page: z.string(), snapshot: z.string() }) satisfies Codec<T.PkmClip>;

export const PkmClusterRequest = z.object({ topic: z.string(), title: z.string() }) satisfies Codec<T.PkmClusterRequest>;

export const PkmCluster = z.object({ page: z.string(), blocks: z.array(z.string()) }) satisfies Codec<T.PkmCluster>;

export const PkmRenameRequest = z.object({ from: z.string(), to: z.string() }) satisfies Codec<T.PkmRenameRequest>;

export const PkmRename = z.object({ pages: z.array(z.string()), into: z.string() }) satisfies Codec<T.PkmRename>;

export const PkmMarkdown = z.object({ markdown: z.string() }) satisfies Codec<T.PkmMarkdown>;

export const PkmUndo = z.object({
  undone: z.boolean(),
  page: z.exactOptional(z.string()),
  what: z.exactOptional(z.string()),
}) satisfies Codec<T.PkmUndo>;

export const PkmScan = z.object({ scanned: z.number().int(), updated: z.number().int(), removed: z.number().int() }) satisfies Codec<T.PkmScan>;
