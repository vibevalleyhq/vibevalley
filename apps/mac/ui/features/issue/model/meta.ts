import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

export function issueTagPresets(): readonly string[] {
  return [
    "UX",
    t("web.issue.tags.preset.arch"),
    "MCP",
    "ACP",
    t("web.issue.tags.preset.storage"),
    t("web.issue.tags.preset.voice"),
    t("web.issue.tags.preset.whiteboard"),
    "Bug",
  ];
}

export const issueScopes = ["all", "active", "backlog", "canceled"] as const;
export type IssueScope = (typeof issueScopes)[number];

/** Scope filter matching for IssuesPage toolbar: all (default), active (excludes backlog drafts & canceled), backlog, or canceled. */
export function scopeMatches(scope: IssueScope, issue: Pick<Issue, "status">): boolean {
  switch (scope) {
    case "all":
      return true;
    case "active":
      return issue.status !== "backlog" && issue.status !== "canceled";
    case "backlog":
      return issue.status === "backlog";
    case "canceled":
      return issue.status === "canceled";
  }
}

/** Deduplicated trimmed tag list preserving insertion order. */
export function normalizeTagList(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Direct child issues of `issueId`, sorted by issue number ascending. */
export function childIssuesOf(issueId: string, allIssues: readonly Issue[]): Issue[] {
  return allIssues.filter((item) => item.parent === issueId).toSorted((a, b) => a.number - b.number);
}

/** Set of `issueId` and all direct/transitive descendants so parent selection can never form a cycle. */
function descendantIdsOf(issueId: string, allIssues: readonly Issue[]): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const item of allIssues) {
    if (!item.parent) continue;
    const list = byParent.get(item.parent) ?? [];
    list.push(item.id);
    byParent.set(item.parent, list);
  }
  const blocked = new Set<string>([issueId]);
  const stack = [issueId];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    for (const childId of byParent.get(curr) ?? []) {
      if (!blocked.has(childId)) {
        blocked.add(childId);
        stack.push(childId);
      }
    }
  }
  return blocked;
}

/** Eligible parent options for `issueId`: excludes self and all descendants, sorted by issue number ascending. */
export function eligibleParentOptions(issueId: string, allIssues: readonly Issue[]): { value: string; label: string }[] {
  const excluded = descendantIdsOf(issueId, allIssues);
  return allIssues
    .filter((item) => !excluded.has(item.id))
    .toSorted((a, b) => a.number - b.number)
    .map((item) => ({ value: item.id, label: `#${item.number} ${item.title}` }));
}

/** Formats Unix milliseconds as `YYYY-MM-DD` (UTC), or `""` when unset. */
export function formatIsoDate(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parses `YYYY-MM-DD` into UTC midnight ms; returns `0` for empty string (clear) or `undefined` if invalid. */
export function parseIsoDateInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return undefined;
  return ms;
}
