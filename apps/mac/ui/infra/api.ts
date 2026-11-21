import { t } from "@vibevalley/i18n";
import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import { type ApiErrorKind, bizCodeMeta, type BizErrorCode, type Next, type VoiceFix } from "@vibevalley/protocol/api";

import { messageOf } from "./base/format";
import { transport } from "./transport";

/** The server could not be reached at all. */
export class ApiConnectionError extends Error {
  override readonly name = "ApiConnectionError";
  constructor(cause: unknown) {
    super(t("web.base.unreachable"), { cause });
  }
}

export interface UiFault {
  readonly bizCode?: BizErrorCode;
  readonly tag: ApiErrorKind | "Network" | "Client";
  readonly reason: string;
  readonly next?: readonly Next[];
  readonly settings?: VoiceFix;
  readonly retryable: boolean;
}

/** Calls the in-process Rust server directly through the current bridge transport. */
export const api = VibeValleyApi.over(async (op, input) => {
  try {
    return await transport().call(op, input);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiConnectionError(error);
    throw error;
  }
});

/** What a refusal says, for a toast or an inline line. */
export const reasonOf = (e: unknown) => (e instanceof VibeValleyApiError ? e.reason : messageOf(e));

/** The fault a refusal or connection failure carries. */
export function faultOf(e: unknown): UiFault {
  if (e instanceof VibeValleyApiError) {
    if (e.tag !== undefined) {
      return {
        ...(e.bizCode !== undefined ? { bizCode: e.bizCode } : {}),
        tag: e.tag,
        reason: e.reason,
        ...(e.error?.next ? { next: e.error.next } : {}),
        ...(e.error?.settings ? { settings: e.error.settings } : {}),
        retryable: e.bizCode !== undefined ? bizCodeMeta[e.bizCode].retryable : e.tag === "VoiceCallFailed" || e.status >= 500,
      };
    }
    return {
      tag: "Client",
      reason: e.reason,
      retryable: e.status >= 500 || e.status === 408 || e.status === 429,
    };
  }
  if (e instanceof ApiConnectionError) {
    return { tag: "Network", reason: e.message, retryable: true };
  }
  return { tag: "Client", reason: messageOf(e), retryable: false };
}

/** A client's key for one send: a retry with the same key is the same message, said once. */
export const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex SHA-256 digest of UTF-8 `text`, computed in Rust with WebCrypto fallback for headless tests. */
export async function sha256Hex(text: string): Promise<string> {
  try {
    const envelope = await transport().call("host.sha256", { text });
    const data = envelope.bizCode === 0 && typeof envelope.data === "object" && envelope.data !== null ? envelope.data : undefined;
    const hex = data && "hex" in data ? data.hex : undefined;
    if (typeof hex === "string" && hex.length === 64) return hex;
  } catch {
    // Offline/fixture transport without host.sha256 falls through to WebCrypto below.
  }
  const subtle = typeof crypto === "object" && "subtle" in crypto ? crypto.subtle : undefined;
  if (subtle !== undefined && typeof subtle.digest === "function") {
    const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("SHA-256 unavailable: host.sha256 failed and WebCrypto is absent");
}

/** The request key of one thing the user may send again (a form's create, a button's). a new one after. */
export function createRequestKey() {
  let key = newSendKey();
  return {
    now: () => key,
    /** It went through: the next send is another thing. */
    used: () => void (key = newSendKey()),
  };
}
