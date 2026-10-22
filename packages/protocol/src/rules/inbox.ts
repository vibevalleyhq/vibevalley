// What in the inbox is news: the server tells it on a call, the page rings and notifies with it.

import type { InboxItem } from "../shapes";

/** The items of now that are news to known: undefined known is the first look, which knows them all and has no news.
 * An id is news once; a helper's next round asks under a new id. */
export function freshOf(known: ReadonlySet<string> | undefined, items: readonly InboxItem[]): { fresh: InboxItem[]; known: Set<string> } {
  const next = new Set(known);
  const fresh = items.filter((i) => !next.has(i.id));
  for (const i of fresh) next.add(i.id);
  return { fresh: known === undefined ? [] : fresh, known: next };
}
