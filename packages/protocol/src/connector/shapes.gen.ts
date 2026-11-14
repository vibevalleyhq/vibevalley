// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export const ConnectorIDValues = ["weixin", "feishu", "qq"] as const;
export type ConnectorID = (typeof ConnectorIDValues)[number];

export const ConnectorStateValues = ["off", "waiting", "scanned", "verify", "pairing", "connected", "paused"] as const;
export type ConnectorState = (typeof ConnectorStateValues)[number];

export type ConnectorStatus = { id: ConnectorID, state: ConnectorState, qr: string, pairCode: string, channel?: string, user?: string, since?: number, lastInbound?: number, pausedUntil?: number, pending: number, error: string, };

export type ConnectorLogin = { force?: boolean, appId?: string, secret?: string, };

export type VerifyRequest = { code: string, };

export type ConnectorsChannelRequest = { channel: string, };

export type FactConnectorChanged = { "type": "connectorChanged", at: number, status: ConnectorStatus, };

export type ConnectorLoginInput = { id: string, force?: boolean, appId?: string, secret?: string, };

export type ConnectorVerifyInput = { id: string, code: string, };

export type ConnectorLogoutInput = { id: string, };

export type ConnectorChannelSetInput = { id: string, channel: string, };
