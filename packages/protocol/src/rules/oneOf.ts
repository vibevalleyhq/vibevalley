// Whether a value is one of a closed set's members, narrowed to the set's type: `includes` on the set would need the
// value cast first.

export const isOneOf = <const T>(values: readonly T[], v: unknown): v is T => values.some((x) => x === v);
