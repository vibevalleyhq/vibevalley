/** An object that is not an array: the shape a JSON object is read as. */
export const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u);
