import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface SessionHandlers<R = never> {
  /** Stops a session's turn; it stays, and a comment starts the next. */
  readonly "session.stop": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  readonly "session.list": (a: { readonly agent?: string }) => Effect.Effect<T.Session[], ApiError, R>;
  readonly "session.get": (a: { readonly id: string }) => Effect.Effect<T.Session, ApiError, R>;
  /** Its log, oldest first. run gives one run's only. */
  readonly "session.event.list": (a: { readonly id: string; readonly run?: string }) => Effect.Effect<T.SessionEvent[], ApiError, R>;
}

export const sessionEndpoints: readonly Endpoint[] = [
  {
    op: "session.stop",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: undefined,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "session.list",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String) }),
    result: Schema.mutable(Schema.Array(S.Session)),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "session.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Session,
    can: ["user", "remote"],
  },
  {
    op: "session.event.list",
    about: ["id"],
    input: input({ id: Schema.String, run: Schema.optionalKey(Schema.String) }),
    result: Schema.mutable(Schema.Array(S.SessionEvent)),
    can: ["user", "remote"],
  },
];
