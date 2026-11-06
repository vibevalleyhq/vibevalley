// PKM (docs/subsystems/pkm.md): the owner's notes as Logseq-style outlines in PARA folders. The files are the truth.

export const PkmTierValues = ["inbox", "project", "area", "resource", "archive", "journal"] as const;
/** Where a page sits in PARA, which is the folder its file is in. */
export type PkmTier = (typeof PkmTierValues)[number];

export const PkmMarkerValues = ["TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"] as const;
export type PkmMarker = (typeof PkmMarkerValues)[number];

export const PkmPriorityValues = ["A", "B", "C"] as const;
export type PkmPriority = (typeof PkmPriorityValues)[number];

/** One bullet of a page, in the page's order (pre-order); parent and depth say the outline. */
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
  /** The bullet's text without its marker and priority; more lines after a newline. */
  body: string;
  /** Its key:: value lines, id:: aside. */
  props: Record<string, string>;
  /** The first lines of the blocks above it, " > " between: what a hit or a backlink shows it under. */
  path: string;
}

export interface PkmPageSummary {
  slug: string;
  title: string;
  tier: PkmTier;
  /** Relative to the vault. */
  file: string;
  tldr: string;
  updated: number;
  /** Its blocks marked TODO, DOING, NOW, LATER or WAITING. */
  open: number;
  /** A journal's day (YYYY-MM-DD), read from its file's name; none for other pages. */
  day?: string;
}

export interface PkmVault {
  /** The folder the pages are in. */
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

/** A ((block)) the page refers to, as it reads now; one that refers back to where it is shown is circular. */
export interface PkmTransclusion {
  block: string;
  found: boolean;
  circular?: boolean;
  page?: string;
  pageTitle?: string;
  body: string;
}

export interface PkmBacklink {
  block: string;
  page: string;
  pageTitle: string;
  tier: PkmTier;
  /** Where it is: the first lines of the blocks above it, as plain words. */
  path: string;
  body: string;
}

/** The blocks of other pages that link here, by where they are in PARA. */
export interface PkmBacklinks {
  projects: PkmBacklink[];
  journals: PkmBacklink[];
  areas: PkmBacklink[];
  archives: PkmBacklink[];
}

export const PkmCommentStatusValues = ["open", "suggested", "accepted", "rejected"] as const;
export type PkmCommentStatus = (typeof PkmCommentStatusValues)[number];

/** A remark on a block: the owner's (==span==^[remark] or comment:: in the file), or a rewrite proposed for it. */
export interface PkmComment {
  id: string;
  page: string;
  block: string;
  /** The words it is on, for an inline one. */
  span?: string;
  by: string;
  body: string;
  status: PkmCommentStatus;
  /** The block's text as proposed. */
  suggested?: string;
  rationale?: string;
  created: number;
  resolved?: number;
}

export interface PkmPageView {
  page: PkmPage;
  transclusions: PkmTransclusion[];
  backlinks: PkmBacklinks;
  /** Open and suggested, oldest first. */
  comments: PkmComment[];
}

/** A page to make, or the props and tier of one there; markdown is its outline when it is made. */
export interface PkmPageRequest {
  title: string;
  tier?: PkmTier;
  props?: Record<string, string>;
  markdown?: string;
}

export interface PkmPageRef {
  /** A slug, a title or an alias. */
  page: string;
}

export interface PkmMoveRequest {
  page: string;
  tier: PkmTier;
}

interface PkmNewBlock {
  /** Given by whoever inserts it (a page's editor), else made by the server. */
  id?: string;
  body: string;
  marker?: PkmMarker;
  priority?: PkmPriority;
  props?: Record<string, string>;
}

/** One change to a page's outline. Ops on a block not on the page change nothing. */
export type PkmBlockOp =
  | ({ op: "append" } & PkmNewBlock)
  | ({ op: "insert_before"; block: string } & PkmNewBlock)
  | ({ op: "insert_after"; block: string } & PkmNewBlock)
  | ({ op: "insert_child"; block: string } & PkmNewBlock)
  | { op: "update"; block: string; body?: string; priority?: PkmPriority; props?: Record<string, string> }
  /** No marker takes it off. */
  | { op: "set_marker"; block: string; marker?: PkmMarker }
  /** TODO → DOING → DONE → TODO, LATER → NOW → DONE; none becomes TODO. */
  | { op: "toggle_marker"; block: string }
  | { op: "delete"; block: string }
  | { op: "indent"; block: string }
  | { op: "outdent"; block: string }
  | { op: "move"; block: string; direction: PkmMoveDirection }
  /** With everything under it, before or after target, or inside it as its first child; none into itself or under itself. */
  | { op: "move_to"; block: string; target: string; at: PkmMoveAt };

export interface PkmMutation {
  page: string;
  ops: PkmBlockOp[];
}

export interface PkmSearchRequest {
  text?: string;
  tier?: PkmTier;
  marker?: PkmMarker;
  /** Only blocks that link to this page. */
  linkedTo?: string;
  /** Default 10. */
  limit?: number;
}

export interface PkmSearchHit {
  block: string;
  page: string;
  pageTitle: string;
  tier: PkmTier;
  marker?: PkmMarker;
  /** Where it is: the first lines of the blocks above it, as plain words. */
  path: string;
  body: string;
  /** The block's text as one line: a [[link]] as its words, a ((ref)) read out, remarks and Markdown marks taken off. */
  plain: string;
  score: number;
  /** The blocks under it, so a hit reads whole. */
  children: PkmBlock[];
}

export interface PkmCaptureRequest {
  /** One line, or an outline: a line a block, nested by its indentation, a leading "- " or not. */
  text: string;
  /** A page's slug, title or alias: the blocks go at its end as they are. None: today's journal, each top block a
   * LATER tagged #inbox. */
  page?: string;
}

/** A page's file as it is written (its id:: lines included), and when it was last written: what `pkm page edit` opens. */
export interface PkmSource {
  page: string;
  title: string;
  markdown: string;
  updated: number;
}

/** The page's file written anew from markdown; refused when the file changed since updated (it was read). */
export interface PkmSourceUpdate {
  page: string;
  markdown: string;
  updated: number;
}

export interface PkmJournalRequest {
  /** YYYY-MM-DD. */
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
  /** The block's text as one line, as a search hit has it. */
  plain: string;
  deadline: string;
}

/** What wants a look: pages left in the inbox, projects untouched for staleDays, blocks past their deadline::. */
export interface PkmRadar {
  inbox: number;
  stale: PkmStaleProject[];
  overdue: PkmOverdue[];
}

export interface PkmProposalRequest {
  block: string;
  suggested: string;
  rationale?: string;
  /** The remark it answers; none is the block's newest. */
  comment?: string;
}

/** The [[links]] and ((refs)) the old text had: every one is kept, the ones the proposal dropped put back at its end. */
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

/** A clipped URL is one page: clipped again, its highlights are added to that page. */
export interface PkmClip {
  duplicate: boolean;
  page: string;
  /** The raw content as clipped, relative to the vault. */
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

/** A page renamed, or merged into one already named so; every [[link]] to the old name now says the new one. */
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
