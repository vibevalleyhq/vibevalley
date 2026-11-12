import { z } from "zod";

import { type Clock, isAbort, withTimeout } from "@vibevalley/async";
import type { ConnectorID, ConnectorLogin, ConnectorState } from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";
import { problemOf } from "#/base/json.ts";

export const Inbound = z.object({
  /** Each is taken once. */
  id: z.string(),
  from: z.string(),
  text: z.string(),
  /** WeChat's context token, QQ's message id; "" for none. */
  reply: z.string(),
  /** The app's id of the message this one quotes; "" for none. */
  quoted: z.string(),
});
export type Inbound = z.output<typeof Inbound>;

export type AppFailedKind = "restricted" | "stale" | "failed";

/** Why an app did not do what it was asked. The message is what the user sees. */
export class AppFailed extends Error {
  override readonly name = "AppFailed";
  readonly kind: AppFailedKind;
  constructor(kind: AppFailedKind, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
  }
}

export const failedWith = (message: string) => new AppFailed("failed", message);

/** A thrown or rejected value, as an app's failure: one already is stays as it is. */
export const failedOf = (e: unknown): AppFailed => (e instanceof AppFailed ? e : new AppFailed("failed", messageOf(e), { cause: e }));

/** f with a deadline of ms on clock: past it, what onLate gives (or throws). An abort of signal itself goes on up. */
export async function timed<A>(f: (signal: AbortSignal) => Promise<A>, ms: number, clock: Clock, signal: AbortSignal | undefined, onLate: () => A): Promise<A> {
  try {
    return await withTimeout(f, ms, { clock, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError" && signal?.aborted !== true) return onLate();
    throw e;
  }
}

/** A failure as an app's, in label's words; an abort goes on up as it is. */
export const appFailure = (e: unknown, signal: AbortSignal | undefined, words: (why: string) => string): unknown =>
  e instanceof AppFailed || isAbort(e, signal) ? e : failedWith(words(e instanceof z.ZodError ? problemOf(e) : messageOf(e)));

export type Secrets = Readonly<Record<string, string>>;

export interface Linked {
  readonly secrets: Secrets;
  /** The user's id in the app; "" until the user pairs by a message. */
  readonly user: string;
}

export interface Progress {
  readonly state: ConnectorState;
  /** The code to scan; "" while there is none. */
  readonly qr: string;
}

export interface Receiving {
  readonly cursor: string;
  /** Kept durably before it returns: only then may the app consider them taken. Throws AppFailed. */
  readonly accept: (messages: readonly Inbound[], cursor: string) => Promise<void>;
}

/** Each throws AppFailed when the app did not do it; an abort of signal goes on up. */
export interface Adapter {
  readonly id: ConnectorID;
  readonly login: (input: ConnectorLogin, progress: (p: Progress) => void, verifyCode: () => string, signal: AbortSignal) => Promise<Linked>;
  /** Until the connection ends: as a failure, or as the end of the app's stream. */
  readonly receive: (secrets: Secrets, io: Receiving, signal: AbortSignal) => Promise<void>;
  readonly send: (secrets: Secrets, to: string, text: string, reply: string) => Promise<string>;
}
