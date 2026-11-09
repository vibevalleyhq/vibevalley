import { Schema } from "effect";

import { t } from "@vibevalley/i18n";
import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import type { ApiError, Next, VoiceFix } from "@vibevalley/protocol/api";

import { messageOf } from "#/base/format.ts";

class ApiConnectionError extends Schema.TaggedError<ApiConnectionError, { readonly brand: unique symbol }>()("ApiConnectionError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return t("web.base.unreachable");
  }
}

export interface UiFault {
  readonly tag: ApiError["_tag"] | "Network" | "Client";
  readonly reason: string;
  readonly next?: readonly Next[];
  readonly settings?: VoiceFix;
  readonly retryable: boolean;
}

/** The page is served by the server it talks to: the same origin. */
export const api = new VibeValleyApi("", async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiConnectionError({ cause: error });
    throw error;
  }
});

/** What a refusal says, for a toast or an inline line. */
export const reasonOf = (e: unknown) => (e instanceof VibeValleyApiError ? e.reason : messageOf(e));

/** The fault a refusal or connection failure carries. */
export function faultOf(e: unknown): UiFault {
  if (e instanceof VibeValleyApiError) {
    const err = e.error;
    if (err) {
      return {
        tag: err._tag,
        reason: e.reason,
        ...((err._tag === "Refused" || err._tag === "Missing") && err.next ? { next: err.next } : {}),
        ...(err._tag === "VoiceUnavailable" && err.settings ? { settings: err.settings } : {}),
        retryable: err._tag === "VoiceCallFailed",
      };
    }
    return {
      tag: "Client",
      reason: e.reason,
      retryable: e.status >= 500 || e.status === 408 || e.status === 429,
    };
  }
  if (Schema.is(ApiConnectionError)(e)) {
    return { tag: "Network", reason: e.message, retryable: true };
  }
  return { tag: "Client", reason: messageOf(e), retryable: false };
}

/** A client's key for one send: a retry with the same key is the same message, said once. */
export const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The request key of one thing the owner may send again (a form's create, a button's). a new one after. */
export function createRequestKey() {
  let key = newSendKey();
  return {
    now: () => key,
    /** It went through: the next send is another thing. */
    used: () => void (key = newSendKey()),
  };
}
