// What connector.ts asks of each chat app: log in, receive until a failure or the signal, send. Each app's adapter sits
// beside its client (weixin.ts, feishu.ts, qq.ts).

import { Data } from "effect";
import type { ConnectorID, ConnectorLogin, ConnectorState } from "@vibevalley/protocol";

export interface Inbound {
  /** Each is taken once. */
  readonly id: string;
  readonly from: string;
  readonly text: string;
  /** WeChat's context token, QQ's message id. */
  readonly reply?: string;
  readonly quoted?: string;
}

export interface Failure {
  readonly kind: "restricted" | "stale" | "failed";
  readonly reason: string;
}

export interface Linked {
  readonly secrets: Record<string, string>;
  readonly owner: string;
}

export interface Progress {
  readonly state: ConnectorState;
  readonly qr?: string;
}

export interface Receiving {
  readonly cursor: string;
  readonly accept: (messages: readonly Inbound[], cursor: string) => Promise<void>;
}

export interface Adapter {
  readonly id: ConnectorID;
  login(signal: AbortSignal, input: ConnectorLogin, progress: (p: Progress) => void, verifyCode: () => string): Promise<Linked>;
  /** Until it fails (a failure) or signal aborts (undefined). */
  receive(signal: AbortSignal, secrets: Record<string, string>, io: Receiving): Promise<Failure | undefined>;
  send(signal: AbortSignal, secrets: Record<string, string>, to: string, text: string, reply: string): Promise<string | Failure>;
}

/** A step with an app that did not go (a login, a send): its message is what the owner sees. */
export class ConnectorFailed extends Data.TaggedError("ConnectorFailed")<{ readonly message: string; readonly cause?: unknown }> {}
