import type { Issue, IssueFilter } from "@vibevalley/protocol";
import { attentionWantsOwner } from "@vibevalley/protocol/rules";
const spaces = /\s+/u;

/** The issues a filter picks, newest first: the open ones unless it asks for closed ones or names a closed status; waiting on
 * the owner, the longest waiting first. */
export function pickIssues(all: readonly Issue[], f: IssueFilter, now: number): Issue[] {
  const words = (f.text ?? "").split(spaces).filter(Boolean);
  const project = (f.project ?? "").trim();
  let found = all.filter(
    (item) =>
      (f.status ? item.status === f.status : f.closed === true || (item.status !== "done" && item.status !== "canceled")) &&
      (f.wantsOwner !== true || attentionWantsOwner(item.attention.state)) &&
      (!project || item.project === project) &&
      words.every((w) => (item.title + "\n" + item.description).includes(w)),
  );
  if (f.wantsOwner === true) found = found.toSorted((a, b) => (a.attention.since ?? now) - (b.attention.since ?? now));
  return f.limit != null && f.limit > 0 ? found.slice(0, Math.trunc(f.limit)) : found;
}
