import type * as T from "@vibevalley/protocol";

/** What came of handing a helper a message. */
export interface Delivered {
  readonly kind: "run" | "steered" | "queued" | "refused";
  readonly launch?: string;
  readonly woke?: boolean;
  readonly reason?: string;
}

/** What a helper's launch did: it spoke, its turn ended or closed, it compacts. */
export type LaunchActivity =
  | { readonly kind: "spoke"; readonly id: string; readonly launch: string }
  | { readonly kind: "ended"; readonly id: string; readonly launch: string; readonly outcome: T.Outcome; readonly spoke: boolean }
  | { readonly kind: "closed"; readonly id: string; readonly launch: string }
  | { readonly kind: "compacting"; readonly id: string; readonly on: boolean };

/** The messages a helper took as input: they are seen. */
export interface InputConsumed {
  readonly session: string;
  readonly messages: string[];
}

/** What happened to a helper: the fact, and the session as it stood after it (none once it left). */
export type SessionNews =
  | { readonly _tag: "hired"; readonly session: T.Session }
  | { readonly _tag: "reported"; readonly report: T.FactReport; readonly session: T.Session | undefined }
  | { readonly _tag: "left"; readonly left: T.FactLeft };
