export interface ConnectorStatus {
  id: ConnectorID;
  state: ConnectorState;
  qr: string;
  pairCode: string;
  channel?: string;
  owner?: string;
  since?: number;
  lastInbound?: number;
  pausedUntil?: number;
  pending: number;
  error: string;
}

export const ConnectorStateValues = ["off", "waiting", "scanned", "verify", "pairing", "connected", "paused"] as const;
export type ConnectorState = (typeof ConnectorStateValues)[number];

export interface ConnectorLogin {
  force?: boolean;
  appId?: string;
  secret?: string;
}

export const ConnectorIDValues = ["weixin", "feishu", "qq"] as const;
export type ConnectorID = (typeof ConnectorIDValues)[number];

export interface VerifyRequest {
  code: string;
}

export interface ConnectorsChannelRequest {
  channel: string;
}

export interface FactConnectorChanged {
  type: "connectorChanged";
  at: number;
  status: ConnectorStatus;
}
