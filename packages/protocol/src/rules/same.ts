// Go's reflect.DeepEqual over values decoded from JSON: a key holding undefined is no key.

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  const kept = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);
  const x = kept(a);
  const y = new Map(kept(b));
  return x.length === y.size && x.every(([k, v]) => y.has(k) && same(v, y.get(k)));
}
