// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

export const DeviceCameValues = ["paired", "login"] as const;
export type DeviceCame = (typeof DeviceCameValues)[number];

export type UserDevice = { id: string, name: string, came: DeviceCame, addedAt: number, lastSeen?: number, };

export type UserStatus = { 
/**
 * "" until set; withheld from unauthenticated LAN requests.
 */
name: string, password: boolean, here: boolean, device?: UserDevice, };

export type UserUpdateRequest = { name: string, };

export type UserPasswordRequest = { password: string, };

export type UserLoginRequest = { password: string, device: string, };

export type UserLogin = { device: string, 
/**
 * Returned once; the server stores only its hash.
 */
key: string, };

export type Approval = { id: string, code: string, name: string, 
/**
 * "" when requested from loopback.
 */
from: string, askedAt: number, expiresAt: number, };

export type ApprovalCreateRequest = { name: string, };

export type ApprovalCreated = { code: string, claim: string, expiresAt: number, 
/**
 * Polling interval in seconds.
 */
every: number, };

export type ApprovalCollectRequest = { claim: string, };

export type ApprovalCollected = { login?: UserLogin, 
/**
 * Updated polling interval in seconds on slow_down (RFC 8628).
 */
every?: number, };

export type ApprovalAnswerRequest = { id: string, allow: boolean, };

export type UserDeviceDeleteInput = { id: string, };

export type UserDevices = Array<{ id: string, name: string, came: DeviceCame, addedAt: number, lastSeen?: number, }>;

export type Approvals = Array<{ id: string, code: string, name: string, 
/**
 * "" when requested from loopback.
 */
from: string, askedAt: number, expiresAt: number, }>;
