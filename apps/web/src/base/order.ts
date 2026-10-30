/** Sort comparators: `or` takes the first that tells the two apart, so a tie of 0 falls through to the next. */
export const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;
