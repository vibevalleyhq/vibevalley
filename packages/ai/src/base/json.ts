/** JSON.stringify's text for value (indented by two spaces when asked); String(value) for what JSON cannot hold
 * (undefined, a cycle, a bigint), where JSON.stringify would throw or give undefined. */
export function jsonText(value: unknown, options?: { readonly indent?: boolean }): string {
  try {
    return JSON.stringify(value, undefined, options?.indent === true ? 2 : undefined) ?? String(value);
  } catch {
    // A cycle or a bigint: the value's own words are what is left to say of it.
    return String(value);
  }
}

/** The value a JSON text holds; undefined when it is not JSON. */
export function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the caller asked for a value or nothing.
    return undefined;
  }
}

/** An object that is not an array: the shape a JSON object is read as. */
export const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
