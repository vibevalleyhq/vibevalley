export const PkmTierValues = ["inbox", "project", "area", "resource", "archive", "journal"] as const;
export type PkmTier = (typeof PkmTierValues)[number];

export const PkmMarkerValues = ["TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"] as const;
export type PkmMarker = (typeof PkmMarkerValues)[number];

export const PkmPriorityValues = ["A", "B", "C"] as const;
export type PkmPriority = (typeof PkmPriorityValues)[number];

export const PkmMoveDirectionValues = ["up", "down"] as const;
export type PkmMoveDirection = (typeof PkmMoveDirectionValues)[number];

export const PkmMoveAtValues = ["before", "after", "inside"] as const;
export type PkmMoveAt = (typeof PkmMoveAtValues)[number];

export interface PkmBlock {
  id: string;
  parent?: string;
  depth: number;
  marker?: PkmMarker;
  priority?: PkmPriority;
  /** Excludes marker and priority; continuation lines follow `\n`. */
  body: string;
  /** Excludes `id::`. */
  props: Record<string, string>;
  path: string;
}

export interface PkmPageSummary {
  slug: string;
  title: string;
  tier: PkmTier;
  /** Relative to vault root. */
  file: string;
  tldr: string;
  updated: number;
  open: number;
  /** `YYYY-MM-DD` for journal pages; absent otherwise. */
  day?: string;
}

export interface PkmVault {
  root: string;
  pages: PkmPageSummary[];
}

export interface PkmPage {
  slug: string;
  title: string;
  tier: PkmTier;
  file: string;
  props: Record<string, string>;
  tldr: string;
  blocks: PkmBlock[];
  updated: number;
}

export interface PkmTransclusion {
  block: string;
  found: boolean;
  /** True when the target block points back to its embedding ancestor chain. */
  circular: boolean;
  page?: string;
  pageTitle?: string;
  body: string;
}

export interface PkmBacklink {
  block: string;
  page: string;
  pageTitle: string;
  tier: PkmTier;
  path: string;
  body: string;
}

export interface PkmBacklinks {
  projects: PkmBacklink[];
  journals: PkmBacklink[];
  areas: PkmBacklink[];
  archives: PkmBacklink[];
}

export const PkmCommentStatusValues = ["open", "suggested", "accepted", "rejected"] as const;
export type PkmCommentStatus = (typeof PkmCommentStatusValues)[number];

export interface PkmComment {
  id: string;
  page: string;
  block: string;
  span?: string;
  by: string;
  body: string;
  status: PkmCommentStatus;
  suggested?: string;
  rationale?: string;
  created: number;
  resolved?: number;
}

export interface PkmPageView {
  page: PkmPage;
  transclusions: PkmTransclusion[];
  backlinks: PkmBacklinks;
  comments: PkmComment[];
}

export interface PkmPageRequest {
  title: string;
  tier?: PkmTier;
  props?: Record<string, string>;
  markdown?: string;
}

export interface PkmPageRef {
  page: string;
}

export interface PkmMoveRequest {
  page: string;
  tier: PkmTier;
}

interface PkmNewBlock {
  id?: string;
  body: string;
  marker?: PkmMarker;
  priority?: PkmPriority;
  props?: Record<string, string>;
}

/** Ops targeting missing blocks are no-ops. */
export type PkmBlockOp =
  | ({ op: "append" } & PkmNewBlock)
  | ({ op: "insert_before"; block: string } & PkmNewBlock)
  | ({ op: "insert_after"; block: string } & PkmNewBlock)
  | ({ op: "insert_child"; block: string } & PkmNewBlock)
  | { op: "update"; block: string; body?: string; priority?: PkmPriority; props?: Record<string, string> }
  /** Omit `marker` to clear it. */
  | { op: "set_marker"; block: string; marker?: PkmMarker }
  /** Cycles `TODO -> DOING -> DONE -> TODO` and `LATER -> NOW -> DONE`; unmarked becomes `TODO`. */
  | { op: "toggle_marker"; block: string }
  | { op: "delete"; block: string }
  | { op: "indent"; block: string }
  | { op: "outdent"; block: string }
  | { op: "move"; block: string; direction: PkmMoveDirection }
  /** Rejects moving a block into or under itself. */
  | { op: "move_to"; block: string; target: string; at: PkmMoveAt };

export interface PkmMutation {
  page: string;
  ops: PkmBlockOp[];
}

export interface PkmSearchRequest {
  text?: string;
  tier?: PkmTier;
  marker?: PkmMarker;
  linkedTo?: string;
  /** Defaults to 10. */
  limit?: number;
}

export interface PkmSearchHit {
  block: string;
  page: string;
  pageTitle: string;
  tier: PkmTier;
  marker?: PkmMarker;
  path: string;
  body: string;
  plain: string;
  score: number;
  children: PkmBlock[];
}

export interface PkmCaptureRequest {
  text: string;
  /** Appends to the named page, or to today's journal as `LATER #inbox` when omitted. */
  page?: string;
}

export interface PkmSource {
  page: string;
  title: string;
  markdown: string;
  updated: number;
}

/** Refused when the file's mtime moved past `updated`. */
export interface PkmSourceUpdate {
  page: string;
  markdown: string;
  updated: number;
}

export interface PkmJournalRequest {
  /** `YYYY-MM-DD`. */
  day: string;
}

export interface PkmStaleProject {
  slug: string;
  title: string;
  days: number;
  deadline?: string;
  todo: number;
  doing: number;
  done: number;
}

export interface PkmOverdue {
  block: string;
  page: string;
  body: string;
  plain: string;
  deadline: string;
}

export interface PkmRadar {
  inbox: number;
  stale: PkmStaleProject[];
  overdue: PkmOverdue[];
}

export interface PkmProposalRequest {
  block: string;
  suggested: string;
  rationale?: string;
  comment?: string;
}

/** Any `[[links]]` or `((refs))` dropped by `suggested` are appended back automatically (`restored`). */
export interface PkmProposal {
  comment: PkmComment;
  kept: string[];
  restored: string[];
}

export interface PkmResolveRequest {
  id: string;
  accept: boolean;
}

export interface PkmClipRequest {
  url: string;
  title: string;
  content: string;
  author?: string;
  tldr?: string;
  highlights?: { text: string; anchor: string }[];
  tags?: string[];
  tier?: PkmTier;
}

/** Re-clipping an existing URL merges new highlights into the existing page. */
export interface PkmClip {
  duplicate: boolean;
  page: string;
  snapshot: string;
}

export interface PkmClusterRequest {
  topic: string;
  title: string;
}

export interface PkmCluster {
  page: string;
  blocks: string[];
}

export interface PkmRenameRequest {
  from: string;
  to: string;
}

/** Rewrites inbound `[[links]]`; merges if target page already exists. */
export interface PkmRename {
  pages: string[];
  into: string;
}

export interface PkmMarkdown {
  markdown: string;
}

export interface PkmUndo {
  undone: boolean;
  page?: string;
  what?: string;
}

export interface PkmScan {
  scanned: number;
  updated: number;
  removed: number;
}
