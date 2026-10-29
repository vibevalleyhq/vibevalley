// An issue's changes to look at before completing: lines added and removed, each file's kind, a patch's marks.

import { t } from "@vibevalley/i18n";
import type { Changes } from "@vibevalley/protocol";

/** A binary file counts -1: not counted. */
export const lineCounts = (c: Changes): [number, number] => [
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.added)), 0),
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.removed)), 0),
];

/** The one line over an issue's changes. */
export function changesLine(c: Changes) {
  const [added, removed] = lineCounts(c);
  const counts = { branch: c.branch ?? "", base: c.base, commits: c.commits.length, added, removed };
  return c.uncommitted.length
    ? t("web.issue.issue.changesUncommitted", { ...counts, uncommitted: c.uncommitted.length })
    : t("web.issue.issue.changes", counts);
}

/** Nothing to merge: completing only lets the helper go. */
export const nothingChanged = (c: Changes) => c.commits.length === 0 && c.uncommitted.length === 0;

/** What a git status letter is, as a mark and a word; an unknown one is itself. */
export function changeKind(status: string) {
  switch (status) {
    case "A":
      return { mark: t("web.issue.issue.change.A.mark"), label: t("web.issue.issue.change.A.label") };
    case "M":
      return { mark: t("web.issue.issue.change.M.mark"), label: t("web.issue.issue.change.M.label") };
    case "D":
      return { mark: t("web.issue.issue.change.D.mark"), label: t("web.issue.issue.change.D.label") };
    default:
      return { mark: status, label: status };
  }
}

export type PatchMark = "added" | "removed" | "hunk" | "plain";

export const patchMarkOf = (line: string): PatchMark =>
  line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : "plain";

/** A patch from its first hunk: the header above it says nothing the file row does not. */
export function patchLines(text: string) {
  const lines = text.split("\n");
  return lines.slice(
    Math.max(
      0,
      lines.findIndex((l) => l.startsWith("@@")),
    ),
  );
}
