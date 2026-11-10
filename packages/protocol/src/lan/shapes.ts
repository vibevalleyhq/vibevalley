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
