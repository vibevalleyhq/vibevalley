// What connector.ts asks of each chat app: log in, receive until the connection fails, send. Each app's adapter sits
// beside its client (weixin.ts, feishu.ts, qq.ts); each is stopped by interrupting it.

import { Data, type Effect } from "effect";

import type { ConnectorID, ConnectorLogin, ConnectorState } from "@vibevalley/protocol";

import { messageOf } from "@/errors.ts";

export interface Inbound {
  /** Each is taken once. */
  readonly id: string;
  readonly from: string;
  readonly text: string;
  /** WeChat's context token, QQ's message id; "" for none. */
  readonly reply: string;
  /** The app's id of the message this one quotes; "" for none. */
  readonly quoted: string;
}

/** Why an app did not do what it was asked: stale is a login it no longer honours, restricted a reply it will not take
 * now (its window has closed), failed anything else. The message is what the owner sees. */
export class AppFailed extends Data.TaggedError("AppFailed")<{
  readonly kind: "restricted" | "stale" | "failed";
  readonly message: string;
}> {}

export const failedWith = (message: string) => new AppFailed({ kind: "failed", message });

/** A thrown or rejected value, as an app's failure. */
export const failedOf = (e: unknown) => failedWith(messageOf(e));

export type Secrets = Readonly<Record<string, string>>;

export interface Linked {
  readonly secrets: Secrets;
  /** The owner's id in the app; "" until the owner pairs by a message. */
  readonly owner: string;
}

export interface Progress {
  readonly state: ConnectorState;
  /** The code to scan; "" while there is none. */
  readonly qr: string;
}

export interface Receiving {
  readonly cursor: string;
  /** Kept durably before it returns: only then may the app consider them taken. */
  readonly accept: (messages: readonly Inbound[], cursor: string) => Effect.Effect<void, AppFailed>;
}

export interface Adapter {
  readonly id: ConnectorID;
  readonly login: (
    input: ConnectorLogin,
    progress: (p: Progress) => Effect.Effect<void>,
    verifyCode: Effect.Effect<string>,
  ) => Effect.Effect<Linked, AppFailed>;
  /** Until the connection ends: as a failure, or as the end of the app's stream. */
  readonly receive: (secrets: Secrets, io: Receiving) => Effect.Effect<void, AppFailed>;
  readonly send: (secrets: Secrets, to: string, text: string, reply: string) => Effect.Effect<string, AppFailed>;
}
