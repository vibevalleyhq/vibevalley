// The tagged errors the API answers with (@vibevalley/protocol/api), made where a service refuses.

import type { ApiError } from "@vibevalley/protocol/api";

export type { ApiError };

export const refused = (reason: string): ApiError => ({ _tag: "Refused", reason });

export const missing = (what: string): ApiError => ({ _tag: "Missing", what });

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string =>
  "reason" in e && typeof e.reason === "string" ? e.reason : "what" in e && typeof e.what === "string" ? e.what : e._tag;
