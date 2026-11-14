// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export type LanPaired = { device: string, key: string, hostName: string, };

export type LanPairRequest = { code: string, name: string, };

export type LanPairing = { code: string, link: string, expiresAt: number, asking?: string, };

export type LanStatus = { open: boolean, hostName: string, url?: string, problem: string, pairing?: LanPairing, };

export type SetOpenRequest = { open: boolean, };

export type AnswerPairingRequest = { allow: boolean, };
