import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const userDeviceDeleteInput = input({ id: z.string() });

export interface UserHandlers {
  readonly "user.get": () => Promise<T.UserStatus>;
  readonly "user.update": (a: T.UserUpdateRequest) => Promise<T.UserStatus>;
  /** Only on this machine: never through the gate. */
  readonly "user.password.set": (a: T.UserPasswordRequest) => Promise<T.UserStatus>;
  readonly "user.login": (a: T.UserLoginRequest) => Promise<T.UserLogin>;
  /** Takes back the key the request came with. */
  readonly "user.logout": () => Promise<void>;
  readonly "user.device.list": () => Promise<T.UserDevice[]>;
  readonly "user.device.delete": (a: { readonly id: string }) => Promise<T.UserDevice[]>;
  /** What deleting the device would do, refused as it would be; nothing changes. */
  readonly "user.device.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
  /** A device asks to be signed in (the command line's auth login); no key needed. */
  readonly "user.approval.create": (a: T.ApprovalCreateRequest) => Promise<T.ApprovalCreated>;
  /** The asking device collects its key once approved; no key needed, the claim is its proof. */
  readonly "user.approval.collect": (a: T.ApprovalCollectRequest) => Promise<T.ApprovalCollected>;
  readonly "user.approval.list": () => Promise<T.Approval[]>;
  readonly "user.approval.answer": (a: T.ApprovalAnswerRequest) => Promise<T.Approval[]>;
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
