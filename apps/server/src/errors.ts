// The tagged errors the API answers with (@vibevalley/protocol/api), made where a service refuses.

import type { ApiError, Next } from "@vibevalley/protocol/api";

export type { ApiError, Next };

export const refused = (reason: string, next?: readonly Next[]): ApiError => ({ _tag: "Refused", reason, ...(next && next.length > 0 ? { next } : {}) });

export const missing = (what: string, next?: readonly Next[]): ApiError => ({ _tag: "Missing", what, ...(next && next.length > 0 ? { next } : {}) });

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string =>
  "reason" in e && typeof e.reason === "string" ? e.reason : "what" in e && typeof e.what === "string" ? e.what : e._tag;
