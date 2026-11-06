export const isOneOf = <const T>(values: readonly T[], v: unknown): v is T => values.some((x) => x === v);
