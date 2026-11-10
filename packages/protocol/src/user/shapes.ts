/** The cookie a browser keeps its device key in; the gate takes it as it takes the Bearer header. */
export const deviceKeyCookie = "vibevalley_device_key";

/** paired: let in at the gate by the user's nod, and only to what a remote device may do; login: signed in with the password. */
export type DeviceCame = "paired" | "login";

export interface UserDevice {
  id: string;
  name: string;
  came: DeviceCame;
  addedAt: number;
  lastSeen?: number;
}

export interface UserStatus {
  /** What the user is called; "" until set, and never told to a caller at the gate without a key. */
  name: string;
  /** Whether a password is set: without one, nobody signs in from outside. */
  password: boolean;
  /** The request came from this machine, not through the gate. */
  here: boolean;
  /** The device the request came from, when it came through the gate with a key. */
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
  /** What to call this device in the device list. */
  device: string;
}

export interface UserLogin {
  device: string;
  /** Shown once: only its hash is kept. */
  key: string;
}
