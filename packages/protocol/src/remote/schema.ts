import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes.gen";

export const RemotePlatform = z.enum(T.RemotePlatformValues) satisfies Codec<T.RemotePlatform>;

export const RemoteDeviceSummary = z.object({
  id: z.string(),
  name: z.string(),
  platform: RemotePlatform,
  scope: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.exactOptional(z.number()),
  revokedAt: z.exactOptional(z.number()),
}) satisfies Codec<T.RemoteDeviceSummary>;

export const RemoteStatus = z.object({
  enabled: z.boolean(),
  listening: z.boolean(),
  bindAddr: z.exactOptional(z.string()),
  port: z.number(),
  lanIp: z.exactOptional(z.string()),
  tailscaleIp: z.exactOptional(z.string()),
  tailscaleHost: z.exactOptional(z.string()),
  tailscaleOnline: z.boolean(),
  url: z.exactOptional(z.string()),
  devices: z.array(RemoteDeviceSummary),
}) satisfies Codec<T.RemoteStatus>;

export const RemoteEnableRequest = z.object({
  bindAddr: z.exactOptional(z.string()),
  port: z.exactOptional(z.number()),
}) satisfies Codec<T.RemoteEnableRequest>;

export const RemotePairCode = z.object({
  code: z.string(),
  pairUrl: z.string(),
  url: z.string(),
  expiresAt: z.number(),
  scope: z.exactOptional(z.string()),
}) satisfies Codec<T.RemotePairCode>;

export const RemotePairExchangeRequest = z.object({
  code: z.string(),
  deviceName: z.string(),
  platform: RemotePlatform,
  scope: z.exactOptional(z.string()),
}) satisfies Codec<T.RemotePairExchangeRequest>;

export const RemotePairExchangeResult = z.object({
  device: RemoteDeviceSummary,
  token: z.string(),
  serverName: z.string(),
  version: z.string(),
}) satisfies Codec<T.RemotePairExchangeResult>;

export const RemoteDeviceRevokeRequest = z.object({
  id: z.string(),
}) satisfies Codec<T.RemoteDeviceRevokeRequest>;

export const RemoteWhoami = z.object({
  device: z.exactOptional(RemoteDeviceSummary),
  caller: z.string(),
  serverName: z.string(),
  version: z.string(),
  channel: z.string(),
}) satisfies Codec<T.RemoteWhoami>;
