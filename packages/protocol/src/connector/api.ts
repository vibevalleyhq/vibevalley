import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface ConnectorHandlers<R = never> {
  readonly "connector.list": () => Effect.Effect<T.ConnectorStatus[], ApiError, R>;
  readonly "connector.login": (a: { readonly id: T.ConnectorID } & T.ConnectorLogin) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.verify": (a: { readonly id: T.ConnectorID } & T.VerifyRequest) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.logout": (a: { readonly id: T.ConnectorID }) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
  readonly "connector.channel.set": (a: { readonly id: T.ConnectorID } & T.ConnectorsChannelRequest) => Effect.Effect<T.ConnectorStatus, ApiError, R>;
}

export const connectorEndpoints: readonly Endpoint[] = [
  {
    op: "connector.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ConnectorStatus)),
    can: ["owner", "remote"],
  },
  {
    op: "connector.login",
    about: ["id"],
    input: input({ id: Schema.String }, S.ConnectorLogin),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.verify",
    about: ["id"],
    input: input({ id: Schema.String }, S.VerifyRequest),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.logout",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
  {
    op: "connector.channel.set",
    about: ["id"],
    input: input({ id: Schema.String }, S.ConnectorsChannelRequest),
    result: S.ConnectorStatus,
    can: ["owner"],
  },
];
