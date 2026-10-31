export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;
