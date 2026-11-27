// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

export const RemotePlatformValues = ["ios", "android", "cli", "machine", "sandbox", "other"] as const;
export type RemotePlatform = (typeof RemotePlatformValues)[number];

/**
 * Public metadata for a paired remote device; never exposes `token_hash`.
 */
export type RemoteDeviceSummary = { id: string, name: string, platform: RemotePlatform, scope: string, createdAt: number, lastSeenAt?: number, revokedAt?: number, };

export type RemoteStatus = { enabled: boolean, listening: boolean, bindAddr?: string, port: number, lanIp?: string, tailscaleIp?: string, tailscaleHost?: string, tailscaleOnline: boolean, url?: string, devices: Array<RemoteDeviceSummary>, };

export type RemoteEnableRequest = { bindAddr?: string, port?: number, };

export type RemotePairCode = { code: string, pairUrl: string, url: string, expiresAt: number, scope?: string, };

export type RemotePairExchangeRequest = { code: string, deviceName: string, platform: RemotePlatform, scope?: string, };

export type RemotePairExchangeResult = { device: RemoteDeviceSummary, token: string, serverName: string, version: string, };

export type RemoteDeviceRevokeRequest = { id: string, };

export type RemoteWhoami = { device?: RemoteDeviceSummary, caller: string, serverName: string, version: string, channel: string, };
