import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "../shapes";

export const ConnectorID: Codec<T.ConnectorID> = Schema.Literals(T.ConnectorIDValues);

export const ConnectorState: Codec<T.ConnectorState> = Schema.Literals(T.ConnectorStateValues);

export const ConnectorStatus: Codec<T.ConnectorStatus> = Schema.Struct({
  id: ConnectorID,
  state: ConnectorState,
  qr: Schema.String,
  pairCode: Schema.String,
  channel: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Finite),
  lastInbound: Schema.optionalKey(Schema.Finite),
  pausedUntil: Schema.optionalKey(Schema.Finite),
  pending: Schema.Finite,
  error: Schema.String,
});

export const ConnectorLogin: Codec<T.ConnectorLogin> = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  appId: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
});

export const VerifyRequest: Codec<T.VerifyRequest> = Schema.Struct({
  code: Schema.String,
});

export const ConnectorsChannelRequest: Codec<T.ConnectorsChannelRequest> = Schema.Struct({
  channel: Schema.String,
});

export const FactConnectorChanged: Codec<T.FactConnectorChanged> = Schema.Struct({
  type: Schema.Literal("connectorChanged"),
  at: Schema.Finite,
  status: ConnectorStatus,
});
