// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export const PkmTierValues = ["inbox", "project", "area", "resource", "archive", "journal"] as const;
export type PkmTier = (typeof PkmTierValues)[number];

export const PkmMarkerValues = ["TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"] as const;
export type PkmMarker = (typeof PkmMarkerValues)[number];

export const PkmPriorityValues = ["A", "B", "C"] as const;
export type PkmPriority = (typeof PkmPriorityValues)[number];

export type PkmBlock = { id: string, parent?: string, depth: number, marker?: PkmMarker, priority?: PkmPriority, 
/**
 * Excludes marker and priority; continuation lines follow `\n`.
 */
body: string, 
/**
 * Excludes `id::`.
 */
props: { [key in string]: string }, path: string, };

export type PkmPageSummary = { slug: string, title: string, tier: PkmTier, 
/**
 * Relative to vault root.
 */
file: string, tldr: string, updated: number, open: number, 
/**
 * `YYYY-MM-DD` for journal pages; absent otherwise.
 */
day?: string, };

export type PkmVault = { root: string, pages: Array<PkmPageSummary>, };

export type PkmPage = { slug: string, title: string, tier: PkmTier, file: string, props: { [key in string]: string }, tldr: string, blocks: Array<PkmBlock>, updated: number, };

export type PkmTransclusion = { block: string, found: boolean, 
/**
 * True when the target block points back to its embedding ancestor chain.
 */
circular: boolean, page?: string, pageTitle?: string, body: string, };

export type PkmBacklink = { block: string, page: string, pageTitle: string, tier: PkmTier, path: string, body: string, };

export type PkmBacklinks = { projects: Array<PkmBacklink>, journals: Array<PkmBacklink>, areas: Array<PkmBacklink>, archives: Array<PkmBacklink>, };

export const PkmCommentStatusValues = ["open", "suggested", "accepted", "rejected"] as const;
export type PkmCommentStatus = (typeof PkmCommentStatusValues)[number];

export type PkmComment = { id: string, page: string, block: string, span?: string, by: string, body: string, status: PkmCommentStatus, suggested?: string, rationale?: string, created: number, resolved?: number, };

export type PkmPageView = { page: PkmPage, transclusions: Array<PkmTransclusion>, backlinks: PkmBacklinks, comments: Array<PkmComment>, };

export type PkmPageRequest = { title: string, tier?: PkmTier, props?: { [key in string]: string }, markdown?: string, };

export type PkmPageRef = { page: string, };

export type PkmMoveRequest = { page: string, tier: PkmTier, };

export const PkmMoveDirectionValues = ["up", "down"] as const;
export type PkmMoveDirection = (typeof PkmMoveDirectionValues)[number];

export const PkmMoveAtValues = ["before", "after", "inside"] as const;
export type PkmMoveAt = (typeof PkmMoveAtValues)[number];

/**
 * Ops targeting missing blocks are no-ops.
 */
export type PkmBlockOp = { "op": "append", id?: string, body: string, marker?: PkmMarker, priority?: PkmPriority, props?: { [key in string]: string }, } | { "op": "insert_before", block: string, id?: string, body: string, marker?: PkmMarker, priority?: PkmPriority, props?: { [key in string]: string }, } | { "op": "insert_after", block: string, id?: string, body: string, marker?: PkmMarker, priority?: PkmPriority, props?: { [key in string]: string }, } | { "op": "insert_child", block: string, id?: string, body: string, marker?: PkmMarker, priority?: PkmPriority, props?: { [key in string]: string }, } | { "op": "update", block: string, body?: string, priority?: PkmPriority, props?: { [key in string]: string }, } | { "op": "set_marker", block: string, marker?: PkmMarker, } | { "op": "toggle_marker", block: string, } | { "op": "delete", block: string, } | { "op": "indent", block: string, } | { "op": "outdent", block: string, } | { "op": "move", block: string, direction: PkmMoveDirection, } | { "op": "move_to", block: string, target: string, at: PkmMoveAt, };

export type PkmMutation = { page: string, ops: Array<PkmBlockOp>, };

export type PkmSearchRequest = { text?: string, tier?: PkmTier, marker?: PkmMarker, linkedTo?: string, 
/**
 * Defaults to 10.
 */
limit?: number, };

export type PkmSearchHit = { block: string, page: string, pageTitle: string, tier: PkmTier, marker?: PkmMarker, path: string, body: string, plain: string, score: number, children: Array<PkmBlock>, };

export type PkmCaptureRequest = { text: string, 
/**
 * Appends to the named page, or to today's journal as `LATER #inbox` when omitted.
 */
page?: string, };

export type PkmSource = { page: string, title: string, markdown: string, updated: number, };

/**
 * Refused when the file's mtime moved past `updated`.
 */
export type PkmSourceUpdate = { page: string, markdown: string, updated: number, };

export type PkmJournalRequest = { 
/**
 * `YYYY-MM-DD`.
 */
day: string, };

export type PkmStaleProject = { slug: string, title: string, days: number, deadline?: string, todo: number, doing: number, done: number, };

export type PkmOverdue = { block: string, page: string, body: string, plain: string, deadline: string, };

export type PkmRadar = { inbox: number, stale: Array<PkmStaleProject>, overdue: Array<PkmOverdue>, };

export type PkmProposalRequest = { block: string, suggested: string, rationale?: string, comment?: string, };

/**
 * Any `[[links]]` or `((refs))` dropped by `suggested` are appended back automatically (`restored`).
 */
export type PkmProposal = { comment: PkmComment, kept: Array<string>, restored: Array<string>, };

export type PkmResolveRequest = { id: string, accept: boolean, };

export type PkmClipRequestHighlights = { text: string, anchor: string, };

export type PkmClipRequest = { url: string, title: string, content: string, author?: string, tldr?: string, highlights?: Array<PkmClipRequestHighlights>, tags?: Array<string>, tier?: PkmTier, };

/**
 * Re-clipping an existing URL merges new highlights into the existing page.
 */
export type PkmClip = { duplicate: boolean, page: string, snapshot: string, };

export type PkmClusterRequest = { topic: string, title: string, };

export type PkmCluster = { page: string, blocks: Array<string>, };

export type PkmRenameRequest = { from: string, to: string, };

/**
 * Rewrites inbound `[[links]]`; merges if target page already exists.
 */
export type PkmRename = { pages: Array<string>, into: string, };

export type PkmMarkdown = { markdown: string, };

export type PkmUndo = { undone: boolean, page?: string, what?: string, };

export type PkmScan = { scanned: number, updated: number, removed: number, };

export type PkmRadarGetInput = { staleDays?: number, };

export type PkmCommentListInput = { page?: string, };

export type PkmProps = { [key in string]: string };

export type PkmBacklinksSchema = Array<{ block: string, page: string, pageTitle: string, tier: PkmTier, path: string, body: string, }>;
