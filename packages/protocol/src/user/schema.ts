import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "../shapes";

export const UserDevice: Codec<T.UserDevice> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  came: Schema.Literals(["paired", "login"]),
  addedAt: Schema.Finite,
  lastSeen: Schema.optionalKey(Schema.Finite),
});

export const UserStatus: Codec<T.UserStatus> = Schema.Struct({
  name: Schema.String,
  password: Schema.Boolean,
  here: Schema.Boolean,
  device: Schema.optionalKey(UserDevice),
});

export const UserUpdateRequest: Codec<T.UserUpdateRequest> = Schema.Struct({
  name: Schema.String,
});

export const UserPasswordRequest: Codec<T.UserPasswordRequest> = Schema.Struct({
  password: Schema.String,
});

export const UserLoginRequest: Codec<T.UserLoginRequest> = Schema.Struct({
  password: Schema.String,
  device: Schema.String,
});

export const UserLogin: Codec<T.UserLogin> = Schema.Struct({
  device: Schema.String,
  key: Schema.String,
});

export const UserDevices = Schema.mutable(Schema.Array(UserDevice));
