import type { UserDevice } from "../user/shapes";

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
  /** The devices paired here; the ones signed in on are in user.device.list. */
  devices: UserDevice[];
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
