/** Accepted alongside Authorization: Bearer at the LAN gate. */
export const deviceKeyCookie = "vibevalley_device_key";

/** paired: remote-only endpoints approved at the LAN gate; login: password/approval sign-in (all endpoints except password change). */
export const DeviceCameValues = ["paired", "login"] as const;
export type DeviceCame = (typeof DeviceCameValues)[number];

export interface UserDevice {
  id: string;
  name: string;
  came: DeviceCame;
  addedAt: number;
  lastSeen?: number;
}

export interface UserStatus {
  /** "" until set; withheld from unauthenticated LAN requests. */
  name: string;
  password: boolean;
  here: boolean;
  device?: UserDevice;
}

export interface UserUpdateRequest {
  name: string;
}

export interface UserPasswordRequest {
  password: string;
}

export interface UserLoginRequest {
  password: string;
  device: string;
}

export interface UserLogin {
  device: string;
  /** Returned once; the server stores only its hash. */
  key: string;
}

export interface Approval {
  id: string;
  code: string;
  name: string;
  /** "" when requested from loopback. */
  from: string;
  askedAt: number;
  expiresAt: number;
}

export interface ApprovalCreateRequest {
  name: string;
}

export interface ApprovalCreated {
  code: string;
  claim: string;
  expiresAt: number;
  /** Polling interval in seconds. */
  every: number;
}

export interface ApprovalCollectRequest {
  claim: string;
}

export interface ApprovalCollected {
  login?: UserLogin;
  /** Updated polling interval in seconds on slow_down (RFC 8628). */
  every?: number;
}

export interface ApprovalAnswerRequest {
  id: string;
  allow: boolean;
}
