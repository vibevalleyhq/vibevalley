import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "../shapes";
import { PkmMoveAtValues, PkmMoveDirectionValues } from "./shapes";

const pkmProps = Schema.Record(Schema.String, Schema.String);
export const PkmTier: Codec<T.PkmTier> = Schema.Literals(T.PkmTierValues);
export const PkmMarker: Codec<T.PkmMarker> = Schema.Literals(T.PkmMarkerValues);
export const PkmPriority: Codec<T.PkmPriority> = Schema.Literals(T.PkmPriorityValues);

export const PkmBlock: Codec<T.PkmBlock> = Schema.Struct({
  id: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  depth: Schema.Int,
  marker: Schema.optionalKey(PkmMarker),
  priority: Schema.optionalKey(PkmPriority),
  body: Schema.String,
  props: pkmProps,
  path: Schema.String,
});

export const PkmPageSummary: Codec<T.PkmPageSummary> = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  tier: PkmTier,
  file: Schema.String,
  tldr: Schema.String,
  updated: Schema.Finite,
  open: Schema.Int,
  day: Schema.optionalKey(Schema.String),
});

export const PkmVault: Codec<T.PkmVault> = Schema.Struct({
  root: Schema.String,
  pages: Schema.mutable(Schema.Array(PkmPageSummary)),
});

export const PkmPage: Codec<T.PkmPage> = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  tier: PkmTier,
  file: Schema.String,
  props: pkmProps,
  tldr: Schema.String,
  blocks: Schema.mutable(Schema.Array(PkmBlock)),
  updated: Schema.Finite,
});

export const PkmTransclusion: Codec<T.PkmTransclusion> = Schema.Struct({
  block: Schema.String,
  found: Schema.Boolean,
  circular: Schema.optionalKey(Schema.Boolean),
  page: Schema.optionalKey(Schema.String),
  pageTitle: Schema.optionalKey(Schema.String),
  body: Schema.String,
});

export const PkmBacklink: Codec<T.PkmBacklink> = Schema.Struct({
  block: Schema.String,
  page: Schema.String,
  pageTitle: Schema.String,
  tier: PkmTier,
  path: Schema.String,
  body: Schema.String,
});

const pkmBacklinks = Schema.mutable(Schema.Array(PkmBacklink));
export const PkmBacklinks: Codec<T.PkmBacklinks> = Schema.Struct({
  projects: pkmBacklinks,
  journals: pkmBacklinks,
  areas: pkmBacklinks,
  archives: pkmBacklinks,
});

export const PkmComment: Codec<T.PkmComment> = Schema.Struct({
  id: Schema.String,
  page: Schema.String,
  block: Schema.String,
  span: Schema.optionalKey(Schema.String),
  by: Schema.String,
  body: Schema.String,
  status: Schema.Literals(T.PkmCommentStatusValues),
  suggested: Schema.optionalKey(Schema.String),
  rationale: Schema.optionalKey(Schema.String),
  created: Schema.Finite,
  resolved: Schema.optionalKey(Schema.Finite),
});

export const PkmPageView: Codec<T.PkmPageView> = Schema.Struct({
  page: PkmPage,
  transclusions: Schema.mutable(Schema.Array(PkmTransclusion)),
  backlinks: PkmBacklinks,
  comments: Schema.mutable(Schema.Array(PkmComment)),
});

export const PkmPageRequest: Codec<T.PkmPageRequest> = Schema.Struct({
  title: Schema.String,
  tier: Schema.optionalKey(PkmTier),
  props: Schema.optionalKey(pkmProps),
  markdown: Schema.optionalKey(Schema.String),
});

export const PkmPageRef: Codec<T.PkmPageRef> = Schema.Struct({ page: Schema.String });

export const PkmMoveRequest: Codec<T.PkmMoveRequest> = Schema.Struct({ page: Schema.String, tier: PkmTier });

const pkmNewBlock = {
  id: Schema.optionalKey(Schema.String),
  body: Schema.String,
  marker: Schema.optionalKey(PkmMarker),
  priority: Schema.optionalKey(PkmPriority),
  props: Schema.optionalKey(pkmProps),
};
const pkmOn = { block: Schema.String };
export const PkmBlockOp: Codec<T.PkmBlockOp> = Schema.Union([
  Schema.Struct({ op: Schema.tag("append"), ...pkmNewBlock }),
  Schema.Struct({ op: Schema.tag("insert_before"), ...pkmOn, ...pkmNewBlock }),
  Schema.Struct({ op: Schema.tag("insert_after"), ...pkmOn, ...pkmNewBlock }),
  Schema.Struct({ op: Schema.tag("insert_child"), ...pkmOn, ...pkmNewBlock }),
  Schema.Struct({
    op: Schema.tag("update"),
    ...pkmOn,
    body: Schema.optionalKey(Schema.String),
    priority: Schema.optionalKey(PkmPriority),
    props: Schema.optionalKey(pkmProps),
  }),
  Schema.Struct({ op: Schema.tag("set_marker"), ...pkmOn, marker: Schema.optionalKey(PkmMarker) }),
  Schema.Struct({ op: Schema.tag("toggle_marker"), ...pkmOn }),
  Schema.Struct({ op: Schema.tag("delete"), ...pkmOn }),
  Schema.Struct({ op: Schema.tag("indent"), ...pkmOn }),
  Schema.Struct({ op: Schema.tag("outdent"), ...pkmOn }),
  Schema.Struct({ op: Schema.tag("move"), ...pkmOn, direction: Schema.Literals(PkmMoveDirectionValues) }),
  Schema.Struct({ op: Schema.tag("move_to"), ...pkmOn, target: Schema.String, at: Schema.Literals(PkmMoveAtValues) }),
]);

export const PkmMutation: Codec<T.PkmMutation> = Schema.Struct({ page: Schema.String, ops: Schema.mutable(Schema.Array(PkmBlockOp)) });

export const PkmSearchRequest: Codec<T.PkmSearchRequest> = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(PkmTier),
  marker: Schema.optionalKey(PkmMarker),
  linkedTo: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int),
});

export const PkmSearchHit: Codec<T.PkmSearchHit> = Schema.Struct({
  block: Schema.String,
  page: Schema.String,
  pageTitle: Schema.String,
  tier: PkmTier,
  marker: Schema.optionalKey(PkmMarker),
  path: Schema.String,
  body: Schema.String,
  plain: Schema.String,
  score: Schema.Finite,
  children: Schema.mutable(Schema.Array(PkmBlock)),
});

export const PkmCaptureRequest: Codec<T.PkmCaptureRequest> = Schema.Struct({ text: Schema.String, page: Schema.optionalKey(Schema.String) });

export const PkmSource: Codec<T.PkmSource> = Schema.Struct({ page: Schema.String, title: Schema.String, markdown: Schema.String, updated: Schema.Finite });

export const PkmSourceUpdate: Codec<T.PkmSourceUpdate> = Schema.Struct({ page: Schema.String, markdown: Schema.String, updated: Schema.Finite });

export const PkmJournalRequest: Codec<T.PkmJournalRequest> = Schema.Struct({ day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)) });

export const PkmStaleProject: Codec<T.PkmStaleProject> = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  days: Schema.Int,
  deadline: Schema.optionalKey(Schema.String),
  todo: Schema.Int,
  doing: Schema.Int,
  done: Schema.Int,
});

export const PkmOverdue: Codec<T.PkmOverdue> = Schema.Struct({
  block: Schema.String,
  page: Schema.String,
  body: Schema.String,
  plain: Schema.String,
  deadline: Schema.String,
});

export const PkmRadar: Codec<T.PkmRadar> = Schema.Struct({
  inbox: Schema.Int,
  stale: Schema.mutable(Schema.Array(PkmStaleProject)),
  overdue: Schema.mutable(Schema.Array(PkmOverdue)),
});

export const PkmProposalRequest: Codec<T.PkmProposalRequest> = Schema.Struct({
  block: Schema.String,
  suggested: Schema.String,
  rationale: Schema.optionalKey(Schema.String),
  comment: Schema.optionalKey(Schema.String),
});

export const PkmProposal: Codec<T.PkmProposal> = Schema.Struct({
  comment: PkmComment,
  kept: Schema.mutable(Schema.Array(Schema.String)),
  restored: Schema.mutable(Schema.Array(Schema.String)),
});

export const PkmResolveRequest: Codec<T.PkmResolveRequest> = Schema.Struct({ id: Schema.String, accept: Schema.Boolean });

export const PkmClipRequest: Codec<T.PkmClipRequest> = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  content: Schema.String,
  author: Schema.optionalKey(Schema.String),
  tldr: Schema.optionalKey(Schema.String),
  highlights: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Struct({ text: Schema.String, anchor: Schema.String })))),
  tags: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  tier: Schema.optionalKey(PkmTier),
});

export const PkmClip: Codec<T.PkmClip> = Schema.Struct({ duplicate: Schema.Boolean, page: Schema.String, snapshot: Schema.String });

export const PkmClusterRequest: Codec<T.PkmClusterRequest> = Schema.Struct({ topic: Schema.String, title: Schema.String });

export const PkmCluster: Codec<T.PkmCluster> = Schema.Struct({ page: Schema.String, blocks: Schema.mutable(Schema.Array(Schema.String)) });

export const PkmRenameRequest: Codec<T.PkmRenameRequest> = Schema.Struct({ from: Schema.String, to: Schema.String });

export const PkmRename: Codec<T.PkmRename> = Schema.Struct({ pages: Schema.mutable(Schema.Array(Schema.String)), into: Schema.String });

export const PkmMarkdown: Codec<T.PkmMarkdown> = Schema.Struct({ markdown: Schema.String });

export const PkmUndo: Codec<T.PkmUndo> = Schema.Struct({
  undone: Schema.Boolean,
  page: Schema.optionalKey(Schema.String),
  what: Schema.optionalKey(Schema.String),
});

export const PkmScan: Codec<T.PkmScan> = Schema.Struct({ scanned: Schema.Int, updated: Schema.Int, removed: Schema.Int });
