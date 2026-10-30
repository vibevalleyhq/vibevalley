/** What a draft adds to `chips`: split at , and ，, trimmed, without empties or repeats. */
export function splitChips(draft: string, chips: readonly string[]): string[] {
  const parts: string[] = [];
  for (const p of draft.split(/[,，]/u)) {
    const t = p.trim();
    if (t && !chips.includes(t) && !parts.includes(t)) parts.push(t);
  }
  return parts;
}
