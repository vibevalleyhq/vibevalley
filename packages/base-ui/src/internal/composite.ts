// Moving through a row or column of items with the keyboard, the way a tab list, a toolbar, a menu or a listbox does:
// arrows by orientation, Home and End, wrapping when it loops; disabled items are passed over. Pure, so it is tested
// without a DOM.

export type Orientation = "horizontal" | "vertical";

/** The index the key moves to among `count` items (`enabled` says which may take it), or undefined for a key it ignores. */
export function moveIndex(
  key: string,
  current: number,
  count: number,
  o: { orientation: Orientation | "both"; loop: boolean; enabled?: (i: number) => boolean },
): number | undefined {
  const enabled = o.enabled ?? (() => true);
  const next: string[] = o.orientation !== "vertical" ? ["ArrowRight"] : [];
  const prev: string[] = o.orientation !== "vertical" ? ["ArrowLeft"] : [];
  if (o.orientation !== "horizontal") {
    next.push("ArrowDown");
    prev.push("ArrowUp");
  }
  const step = (from: number, by: 1 | -1): number | undefined => {
    for (let i = 1; i <= count; i++) {
      let at = from + by * i;
      if (at < 0 || at >= count) {
        if (!o.loop) return undefined;
        at = (at + count) % count;
      }
      if (enabled(at)) return at;
    }
    return undefined;
  };
  if (key === "Home") return step(-1, 1);
  if (key === "End") return step(count, -1);
  if (next.includes(key)) return step(current, 1) ?? current;
  if (prev.includes(key)) return step(current, -1) ?? current;
  return undefined;
}

/** The next item whose label starts with what was typed, searching from after `current` and wrapping; a repeated single
 * letter cycles through the items starting with it. */
export function typeahead(labels: readonly string[], current: number, typed: string, enabled: (i: number) => boolean = () => true): number | undefined {
  const query = typed.toLowerCase();
  const repeated = query.length > 1 && [...query].every((c) => c === query[0]);
  const search = repeated ? query[0]! : query;
  const start = search.length === 1 || repeated ? current + 1 : Math.max(current, 0);
  for (let i = 0; i < labels.length; i++) {
    const at = (start + i) % labels.length;
    if (enabled(at) && labels[at]!.trim().toLowerCase().startsWith(search)) return at;
  }
  return undefined;
}

/** Keys typed within this long of each other make one search. */
export const typeaheadMs = 500;
