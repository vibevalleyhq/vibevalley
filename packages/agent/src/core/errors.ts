/** A thrown or rejected value as an Error: one that is passes as it is. */
export const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
