import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "./shapes";

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

export const Approval: Codec<T.Approval> = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  name: Schema.String,
  from: Schema.String,
  askedAt: Schema.Finite,
  expiresAt: Schema.Finite,
});

export const Approvals = Schema.mutable(Schema.Array(Approval));

export const ApprovalCreateRequest: Codec<T.ApprovalCreateRequest> = Schema.Struct({
  name: Schema.String,
});

export const ApprovalCreated: Codec<T.ApprovalCreated> = Schema.Struct({
  code: Schema.String,
  claim: Schema.String,
  expiresAt: Schema.Finite,
  every: Schema.Finite,
});

export const ApprovalCollectRequest: Codec<T.ApprovalCollectRequest> = Schema.Struct({
  claim: Schema.String,
});

export const ApprovalCollected: Codec<T.ApprovalCollected> = Schema.Struct({
  login: Schema.optionalKey(UserLogin),
  every: Schema.optionalKey(Schema.Finite),
});

export const ApprovalAnswerRequest: Codec<T.ApprovalAnswerRequest> = Schema.Struct({
  id: Schema.String,
  allow: Schema.Boolean,
});
