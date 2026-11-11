import { type Effect, Schema } from "effect";

import type { ConnectorID, ConnectorLogin, ConnectorState } from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";

export const Inbound = Schema.Struct({
  /** Each is taken once. */
  id: Schema.String,
  from: Schema.String,
  text: Schema.String,
  /** WeChat's context token, QQ's message id; "" for none. */
  reply: Schema.String,
  /** The app's id of the message this one quotes; "" for none. */
  quoted: Schema.String,
});
export type Inbound = typeof Inbound.Type;

const AppFailedKindValues = ["restricted", "stale", "failed"] as const;

/** Why an app did not do what it was asked. The message is what the user sees. */
export class AppFailed extends Schema.TaggedError<AppFailed, { readonly brand: unique symbol }>()("AppFailed", {
  kind: Schema.Literals(AppFailedKindValues),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const failedWith = (message: string) => AppFailed.make({ kind: "failed", message });

/** A thrown or rejected value, as an app's failure. */
export const failedOf = (e: unknown) => AppFailed.make({ kind: "failed", message: messageOf(e), cause: e });

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

interface Receiving {
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
