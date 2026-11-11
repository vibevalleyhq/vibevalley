import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

const ConnectorID = z.enum(T.ConnectorIDValues) satisfies Codec<T.ConnectorID>;

const ConnectorState = z.enum(T.ConnectorStateValues) satisfies Codec<T.ConnectorState>;

export const ConnectorStatus = z.object({
  id: ConnectorID,
  state: ConnectorState,
  qr: z.string(),
  pairCode: z.string(),
  channel: z.exactOptional(z.string()),
  user: z.exactOptional(z.string()),
  since: z.exactOptional(z.number()),
  lastInbound: z.exactOptional(z.number()),
  pausedUntil: z.exactOptional(z.number()),
  pending: z.number(),
  error: z.string(),
}) satisfies Codec<T.ConnectorStatus>;

export const ConnectorLogin = z.object({
  force: z.exactOptional(z.boolean()),
  appId: z.exactOptional(z.string()),
  secret: z.exactOptional(z.string()),
}) satisfies Codec<T.ConnectorLogin>;

export const VerifyRequest = z.object({
  code: z.string(),
}) satisfies Codec<T.VerifyRequest>;

export const ConnectorsChannelRequest = z.object({
  channel: z.string(),
}) satisfies Codec<T.ConnectorsChannelRequest>;

export const FactConnectorChanged = z.object({
  type: z.literal("connectorChanged"),
  at: z.number(),
  status: ConnectorStatus,
}) satisfies Codec<T.FactConnectorChanged>;
