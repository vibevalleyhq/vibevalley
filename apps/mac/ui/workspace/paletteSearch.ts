import type { CommandItem } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Issue, Note, NoteType, Session, SessionView } from "@vibevalley/protocol";
import { oneLine, sessionIssueId, sessionProfile, sessionRepo } from "@vibevalley/protocol/rules";

import type { IconName } from "../design/icons";
import { matches, spelled } from "../infra/base/search";

export interface PaletteEntryInput extends CommandItem {
  readonly detail?: string | undefined;
}

export interface PaletteEntryMeta {
  readonly detail?: string;
  readonly icon?: IconName;
  readonly route?: string;
}

export interface BuiltPaletteEntries {
  readonly items: CommandItem[];
  readonly metaById: ReadonlyMap<string, PaletteEntryMeta>;
}

const MAX_ENTITY_RESULTS = 12;

const COMMAND_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "nav.workspace": ["workspace", "/workspace"],
  "nav.chat": ["chat", "channel", "/chat"],
  "nav.issues": ["issues", "board", "/issues"],
  "nav.dashboard": ["dashboard", "overview", "/dashboard"],
  "nav.dashboard.runs": ["dashboard", "runs", "trajectory", "/dashboard/runs"],
  "nav.dashboard.retro": ["dashboard", "retro", "analytics", "cycle", "/dashboard/retro"],
  "nav.content": ["library", "notes", "/library"],
  "nav.team": ["agents", "experts", "/agents"],
  "nav.runtimes": ["runtimes", "engines", "/runtimes"],
  "nav.repos": ["repos", "repositories", "/repos"],
  "nav.farm": ["farm", "diorama", "/farm"],
  "nav.settings": ["settings", "preferences", "/settings"],
  "issue.new": ["issue.new", "new issue", "create issue", "/issues/new"],
  "issue.next_reviewable": ["review", "reviewable", "pending", "next"],
};

function extraKeywordsForCommand(id: string): readonly string[] {
  const base = COMMAND_KEYWORDS[id] ?? [];
  switch (id) {
    case "nav.dashboard":
      return [...base, t("web.base.place.dashboard.label"), t("web.base.dashboard.title")];
    case "nav.dashboard.runs":
      return [...base, t("web.base.dashboard.tab.runs")];
    case "nav.dashboard.retro":
      return [...base, t("web.base.dashboard.tab.retro"), t("web.base.dashboard.retro.title")];
    case "issue.new":
      return [...base, t("web.issue.new.title")];
    default:
      return base;
  }
}

const NOTE_TYPE_ICONS: Record<NoteType, IconName> = {
  doc: "notes",
  base: "catalog",
  canvas: "idea",
  media: "video",
};

function noteTypeLabel(type: NoteType): string {
  switch (type) {
    case "doc":
      return t("web.note.types.doc");
    case "base":
      return t("web.note.types.base");
    case "canvas":
      return t("web.note.types.canvas");
    case "media":
      return t("web.note.types.media");
  }
}

function issueStatusLabel(status: Issue["status"]): string {
  switch (status) {
    case "backlog":
      return t("web.issue.boardLabels.lane.backlog");
    case "todo":
      return t("web.issue.boardLabels.lane.todo");
    case "in_progress":
      return t("web.issue.boardLabels.lane.in_progress");
    case "in_review":
      return t("web.issue.boardLabels.lane.in_review");
    case "done":
      return t("web.issue.boardLabels.lane.done");
    case "canceled":
      return t("web.issue.boardLabels.lane.canceled");
  }
}

function runStatusLabel(session: Session | SessionView): string {
  switch (session.phase._tag) {
    case "working":
      return t("web.session.hub.status.working");
    case "failed":
      return t("web.session.hub.status.failed");
    case "closed":
      return t("web.session.hub.status.closed");
    case "done":
      return session.lastRun?.outcome === "interrupted" ? t("web.session.hub.status.interrupted") : t("web.session.hub.status.done");
    case "resting":
      return session.lastRun?.outcome === "interrupted" ? t("web.session.hub.status.interrupted") : t("web.session.hub.status.resting");
  }
}

function runActivityAt(session: Session | SessionView): number {
  switch (session.phase._tag) {
    case "working":
      return session.phase.since;
    case "closed":
      return session.phase.at;
    case "resting":
    case "done":
    case "failed":
      return session.lastRun?.at ?? session.hiredAt;
  }
}

function toCommandItem(item: PaletteEntryInput): CommandItem {
  const extra = extraKeywordsForCommand(item.id);
  const mergedKeywords = [...(item.keywords ?? []), ...extra, ...(item.detail ? [item.detail] : [])];
  return {
    id: item.id,
    label: item.label,
    ...(mergedKeywords.length > 0 ? { keywords: mergedKeywords } : {}),
    ...(item.group !== undefined ? { group: item.group } : {}),
    ...(item.shortcut !== undefined ? { shortcut: item.shortcut } : {}),
    ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
  };
}

export function buildStaticPaletteEntries(baseItems: readonly PaletteEntryInput[]): BuiltPaletteEntries {
  const metaById = new Map<string, PaletteEntryMeta>();
  const items: CommandItem[] = [];
  for (const entry of baseItems) {
    items.push(toCommandItem(entry));
    if (entry.detail) metaById.set(entry.id, { detail: entry.detail });
  }
  return { items, metaById };
}

export function buildCommandsPaletteEntries(input: {
  readonly baseItems: readonly PaletteEntryInput[];
  readonly query: string;
  readonly issues: readonly Issue[];
  readonly notes: readonly Note[];
  readonly sessions: readonly Session[];
  readonly liveSessions: readonly SessionView[];
}): BuiltPaletteEntries {
  const q = input.query.trim();
  const qLower = q.toLowerCase();
  const metaById = new Map<string, PaletteEntryMeta>();
  const items: CommandItem[] = [];

  for (const entry of input.baseItems) {
    const cmd = toCommandItem(entry);
    if (q && !matches(q, [entry.label, entry.detail, entry.id, ...(cmd.keywords ?? [])])) continue;
    items.push(cmd);
    if (entry.detail) metaById.set(entry.id, { detail: entry.detail });
  }

  if (!q) {
    return { items, metaById };
  }

  const issueGroup = t("web.shell.palette.groups.issues");
  const matchedIssues = input.issues
    .filter((issue) =>
      matches(q, [`#${issue.number}`, String(issue.number), issue.title, issue.id, issue.repo, issue.status, issue.stage.state, ...(issue.tags ?? [])]),
    )
    .toSorted((a, b) => {
      const aExact = qLower === `#${a.number}` || qLower === String(a.number) ? 0 : 1;
      const bExact = qLower === `#${b.number}` || qLower === String(b.number) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aClosed = a.status === "done" || a.status === "canceled" ? 1 : 0;
      const bClosed = b.status === "done" || b.status === "canceled" ? 1 : 0;
      if (aClosed !== bClosed) return aClosed - bClosed;
      return b.number - a.number;
    })
    .slice(0, MAX_ENTITY_RESULTS);

  for (const issue of matchedIssues) {
    const id = `issue:${issue.id}`;
    const detail = [issue.repo, issueStatusLabel(issue.status)].filter(Boolean).join(" · ");
    items.push({ id, label: `#${issue.number} ${issue.title}`, group: issueGroup });
    metaById.set(id, { detail, icon: "issues", route: `/issues/${encodeURIComponent(issue.id)}` });
  }

  const noteGroup = t("web.shell.palette.groups.artifacts");
  const matchedNotes = input.notes
    .filter((note) => matches(q, [note.title, note.noteType, noteTypeLabel(note.noteType), note.byName, note.id]))
    .toSorted((a, b) => {
      const aTitleHit = spelled(a.title, qLower) ? 0 : 1;
      const bTitleHit = spelled(b.title, qLower) ? 0 : 1;
      if (aTitleHit !== bTitleHit) return aTitleHit - bTitleHit;
      return b.updated - a.updated;
    })
    .slice(0, MAX_ENTITY_RESULTS);

  for (const note of matchedNotes) {
    const id = `note:${note.id}`;
    const typeLabel = noteTypeLabel(note.noteType);
    const detail = [typeLabel, note.byName].filter(Boolean).join(" · ");
    items.push({ id, label: note.title, group: noteGroup });
    metaById.set(id, { detail, icon: NOTE_TYPE_ICONS[note.noteType], route: `/notes/${encodeURIComponent(note.id)}` });
  }

  const issueById = new Map<string, Issue>(input.issues.map((i) => [i.id, i]));
  const mergedSessions = new Map<string, Session | SessionView>();
  for (const s of input.sessions) mergedSessions.set(s.id, s);
  for (const s of input.liveSessions) mergedSessions.set(s.id, s);

  const runGroup = t("web.shell.palette.groups.runs");
  const matchedRuns = [...mergedSessions.values()]
    .filter((s) => {
      const issueId = sessionIssueId(s);
      const linked = issueId !== undefined ? issueById.get(issueId) : undefined;
      return matches(q, [
        s.id,
        s.name,
        sessionProfile(s),
        s.runtime,
        sessionRepo(s),
        oneLine(s.brief),
        linked ? `#${linked.number}` : undefined,
        linked?.title,
      ]);
    })
    .toSorted((a, b) => {
      const aWorking = a.phase._tag === "working" ? 0 : 1;
      const bWorking = b.phase._tag === "working" ? 0 : 1;
      if (aWorking !== bWorking) return aWorking - bWorking;
      return runActivityAt(b) - runActivityAt(a);
    })
    .slice(0, MAX_ENTITY_RESULTS);

  for (const s of matchedRuns) {
    const id = `run:${s.id}`;
    const issueId = sessionIssueId(s);
    const linked = issueId !== undefined ? issueById.get(issueId) : undefined;
    const issueLabel = linked ? `#${linked.number} ${linked.title}` : sessionRepo(s);
    const detail = [sessionProfile(s), s.runtime, issueLabel, runStatusLabel(s)].filter(Boolean).join(" · ");
    items.push({ id, label: s.name, group: runGroup });
    metaById.set(id, { detail, icon: "runtimes", route: `/dashboard/runs?session=${encodeURIComponent(s.id)}` });
  }

  return { items, metaById };
}
