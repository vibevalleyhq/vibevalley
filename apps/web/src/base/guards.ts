/** Not null, not an array: a record to read keys of. */
export function isObject(input: unknown): input is { [x: PropertyKey]: unknown } {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** An object or an array. */
export function isObjectOrArray(input: unknown): input is { [x: PropertyKey]: unknown } | unknown[] {
  return typeof input === "object" && input !== null;
}

/** An object with this `_tag`. */
export const isTagged = <K extends string>(input: unknown, tag: K): input is { readonly _tag: K } => isObject(input) && input["_tag"] === tag;
