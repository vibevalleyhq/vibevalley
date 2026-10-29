// An object without its keys that hold undefined, typed so: a field that may be undefined becomes one that may be absent.
// Shapes leave a field out when it has no value (exactOptionalPropertyTypes), and JSON drops such keys anyway.

export type Omitted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends object>(o: T): Omitted<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Omitted<T>;
}
