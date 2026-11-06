export type Omitted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends object>(o: T): Omitted<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromEntries loses the keys; the filter is exactly what Omitted<T> says
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Omitted<T>;
}
