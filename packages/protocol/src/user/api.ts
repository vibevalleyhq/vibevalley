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
  /** A device asks to be signed in (the command line's auth login); no key needed. */
  readonly "user.approval.create": (a: T.ApprovalCreateRequest) => Effect.Effect<T.ApprovalCreated, ApiError, R>;
  /** The asking device collects its key once approved; no key needed, the claim is its proof. */
  readonly "user.approval.collect": (a: T.ApprovalCollectRequest) => Effect.Effect<T.ApprovalCollected, ApiError, R>;
  readonly "user.approval.list": () => Effect.Effect<T.Approval[], ApiError, R>;
  readonly "user.approval.answer": (a: T.ApprovalAnswerRequest) => Effect.Effect<T.Approval[], ApiError, R>;
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
  { op: "user.approval.create", about: [], input: S.ApprovalCreateRequest, result: S.ApprovalCreated, can: ["user", "remote"] },
  { op: "user.approval.collect", about: [], input: S.ApprovalCollectRequest, result: S.ApprovalCollected, can: ["user", "remote"] },
  { op: "user.approval.list", about: [], input: undefined, result: S.Approvals, can: ["user"] },
  { op: "user.approval.answer", about: ["id"], input: S.ApprovalAnswerRequest, result: S.Approvals, can: ["user"] },
];
