import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";

/** The page is served by the server it talks to: the same origin. */
export const api = new VibeValleyApi("");

/** What a refusal says, for a toast or an inline line. */
export const reasonOf = (e: unknown) => (e instanceof VibeValleyApiError ? e.reason : e instanceof Error ? e.message : String(e));
