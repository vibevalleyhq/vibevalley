/** Every word of the query is somewhere in the texts, ignoring case; an empty query matches everything. */
export function matches(query: string, texts: readonly (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}
