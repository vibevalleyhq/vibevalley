import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

const UserDevice = z.object({
  id: z.string(),
  name: z.string(),
  came: z.enum(T.DeviceCameValues),
  addedAt: z.number(),
  lastSeen: z.exactOptional(z.number()),
}) satisfies Codec<T.UserDevice>;

export const UserStatus = z.object({
  name: z.string(),
  password: z.boolean(),
  here: z.boolean(),
  device: z.exactOptional(UserDevice),
}) satisfies Codec<T.UserStatus>;

export const UserUpdateRequest = z.object({
  name: z.string(),
}) satisfies Codec<T.UserUpdateRequest>;

export const UserPasswordRequest = z.object({
  password: z.string(),
}) satisfies Codec<T.UserPasswordRequest>;

export const UserLoginRequest = z.object({
  password: z.string(),
  device: z.string(),
}) satisfies Codec<T.UserLoginRequest>;

export const UserLogin = z.object({
  device: z.string(),
  key: z.string(),
}) satisfies Codec<T.UserLogin>;

export const UserDevices = z.array(UserDevice);

const Approval = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  from: z.string(),
  askedAt: z.number(),
  expiresAt: z.number(),
}) satisfies Codec<T.Approval>;

export const Approvals = z.array(Approval);

export const ApprovalCreateRequest = z.object({
  name: z.string(),
}) satisfies Codec<T.ApprovalCreateRequest>;

export const ApprovalCreated = z.object({
  code: z.string(),
  claim: z.string(),
  expiresAt: z.number(),
  every: z.number(),
}) satisfies Codec<T.ApprovalCreated>;

export const ApprovalCollectRequest = z.object({
  claim: z.string(),
}) satisfies Codec<T.ApprovalCollectRequest>;

export const ApprovalCollected = z.object({
  login: z.exactOptional(UserLogin),
  every: z.exactOptional(z.number()),
}) satisfies Codec<T.ApprovalCollected>;

export const ApprovalAnswerRequest = z.object({
  id: z.string(),
  allow: z.boolean(),
}) satisfies Codec<T.ApprovalAnswerRequest>;
