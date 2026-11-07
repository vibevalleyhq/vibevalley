import { Predicate, type Schema } from "effect";

// A JSON null is a field value, not an absent optional key.
export type FormValue = Schema.Json | undefined | readonly FormValue[] | { readonly [key: string]: FormValue };
export type Path<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
  ? readonly []
  : T extends readonly (infer V)[]
    ? readonly [] | readonly [number, ...Path<V, [...Depth, unknown]>]
    : T extends object
      ? readonly [] | { [K in Extract<keyof T, string>]-?: readonly [K, ...Path<T[K], [...Depth, unknown]>] }[Extract<keyof T, string>]
      : readonly [];
export type PathValue<T, P extends readonly (string | number)[]> = P extends readonly [infer K, ...infer Rest extends readonly (string | number)[]]
  ? K extends keyof NonNullable<T>
    ? PathValue<NonNullable<T>[K], Rest> | (undefined extends T ? undefined : never)
    : never
  : T;
const safe = (path: readonly (string | number)[]) => {
  if (
    path.some(
      (key) => key === "__proto__" || key === "constructor" || key === "prototype" || (typeof key === "number" && (!Number.isSafeInteger(key) || key < 0)),
    )
  )
    throw new Error("Unsafe form path");
};
function read(value: unknown, path: readonly (string | number)[]): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value) && typeof key === "number") return read(value[key], rest);
  if (Predicate.isObject(value) && typeof key === "string") return read(Object.hasOwn(value, key) ? value[key] : undefined, rest);
  throw new Error("Form path traverses a non-record value");
}
function patch(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return next;
  if (Array.isArray(value) && typeof key === "number" && key < value.length)
    return value.map((item: unknown, index) => (index === key ? patch(item, rest, next) : item));
  if (Predicate.isObject(value) && typeof key === "string") return { ...value, [key]: patch(Object.hasOwn(value, key) ? value[key] : undefined, rest, next) };
  throw new Error("Set the missing parent or array before editing its fields");
}
export function at<T, const P extends Path<T>>(value: T, path: P): PathValue<T, P>;
export function at(value: unknown, path: readonly (string | number)[]): unknown {
  safe(path);
  return read(value, path);
}
export function replace<T, const P extends Path<T>>(value: T, path: P, next: PathValue<T, P>): T;
export function replace(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  safe(path);
  return patch(value, path, next);
}
export function immutable<T extends FormValue>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (part: FormValue): void => {
    if (Predicate.isObjectOrArray(part)) {
      Object.values(part).forEach(freeze);
      Object.freeze(part);
    }
  };
  freeze(copy);
  return copy;
}
