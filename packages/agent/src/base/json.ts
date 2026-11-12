/** An object that is not an array: the shape a JSON object is read as. */
export const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);

/** JSON.stringify's text for value; String(value) for what JSON cannot hold (undefined, a cycle, a bigint), where
 * JSON.stringify would throw or give undefined. */
export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A cycle or a bigint: the value's own words are what is left to say of it.
    return String(value);
  }
}
