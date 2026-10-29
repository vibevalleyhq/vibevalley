// Orders for sort: text by its code points, numbers by size, and the first comparison that is not a tie.

/** Go's cmp.Compare for strings: by bytes of UTF-8, which is by code point, not by UTF-16 unit. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}

export const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/** cmp.Or: the first that is not 0. */
export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;
