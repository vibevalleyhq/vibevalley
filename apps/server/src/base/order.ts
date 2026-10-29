/** By UTF-8 bytes, which is by code point, not by UTF-16 unit: the order the recorded cases were sorted in. */
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

export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;
