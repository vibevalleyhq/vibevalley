import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const userDeviceDeleteInput = input({ id: Schema.String });

export interface UserHandlers<R = never> {
  readonly "user.get": () => Effect.Effect<T.UserStatus, ApiError, R>;
  readonly "user.update": (a: T.UserUpdateRequest) => Effect.Effect<T.UserStatus, ApiError, R>;
  /** Only on this machine: never through the gate. */
  readonly "user.password.set": (a: T.UserPasswordRequest) => Effect.Effect<T.UserStatus, ApiError, R>;
  readonly "user.login": (a: T.UserLoginRequest) => Effect.Effect<T.UserLogin, ApiError, R>;
  /** Takes back the key the request came with. */
  readonly "user.logout": () => Effect.Effect<void, ApiError, R>;
  readonly "user.device.list": () => Effect.Effect<T.UserDevice[], ApiError, R>;
  readonly "user.device.delete": (a: { readonly id: string }) => Effect.Effect<T.UserDevice[], ApiError, R>;
  /** What deleting the device would do, refused as it would be; nothing changes. */
  readonly "user.device.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
}

export const userEndpoints: readonly Endpoint[] = [
  { op: "user.get", about: [], input: undefined, result: S.UserStatus, can: ["user", "remote"] },
  { op: "user.update", about: [], input: S.UserUpdateRequest, result: S.UserStatus, can: ["user"] },
  { op: "user.password.set", about: [], input: S.UserPasswordRequest, result: S.UserStatus, can: ["user"] },
  { op: "user.login", about: [], input: S.UserLoginRequest, result: S.UserLogin, can: ["user", "remote"] },
  { op: "user.logout", about: [], input: undefined, result: undefined, can: ["user", "remote"] },
  { op: "user.device.list", about: [], input: undefined, result: S.UserDevices, can: ["user"] },
  {
    op: "user.device.delete",
    about: ["id"],
    input: userDeviceDeleteInput,
    result: S.UserDevices,
    can: ["user"],
    dryRun: "user.device.previewDelete",
  },
  { op: "user.device.previewDelete", about: ["id"], input: userDeviceDeleteInput, result: S.Preview, can: ["user"] },
];
