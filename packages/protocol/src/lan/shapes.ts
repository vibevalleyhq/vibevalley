/** The cookie a paired browser keeps its lan key in; the lan listener takes it as it takes the Bearer header. */
export const lanKeyCookie = "vibevalley_lan_key";

export interface LanDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen?: number;
}

export interface LanPaired {
  device: string;
  key: string;
  hostName: string;
}

export interface LanPairRequest {
  code: string;
  name: string;
}

export interface LanStatus {
  open: boolean;
  hostName: string;
  url?: string;
  problem: string;
  pairing?: LanPairing;
  devices: LanDevice[];
}

export interface LanPairing {
  code: string;
  link: string;
  expiresAt: number;
  asking?: string;
}

export interface SetOpenRequest {
  open: boolean;
}

export interface AnswerPairingRequest {
  allow: boolean;
}
