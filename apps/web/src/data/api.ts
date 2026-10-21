import { QueryClient } from "@tanstack/react-query";
import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";

/** The page is served by the server it talks to: the same origin. */
export const api = new VibeValleyApi("");

/** REST reads besides the state stream (history, changes, …); a frame that changes what they show invalidates them. */
export const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** What a refusal says, for a toast or an inline line. */
export const reasonOf = (e: unknown) => (e instanceof VibeValleyApiError ? e.reason : e instanceof Error ? e.message : String(e));
