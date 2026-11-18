import { z } from "zod";

import { Look } from "../agent/schema";
import type { Codec } from "../codec";
import * as T from "./shapes";

const RuntimeQuota = z.object({
  left: z.exactOptional(z.number()),
  text: z.string(),
}) satisfies Codec<T.RuntimeQuota>;

export const RuntimePreset = z.object({
  id: z.string(),
  label: z.string(),
  blurb: z.string(),
  look: Look,
}) satisfies Codec<T.RuntimePreset>;

const RuntimeCapability = z.enum(T.RuntimeCapabilityValues) satisfies Codec<T.RuntimeCapability>;

export const RuntimeSupport = z.object({
  steer: z.boolean(),
  refused: z.record(z.string(), z.string()),
  capabilities: z.array(RuntimeCapability),
  inProcess: z.boolean(),
}) satisfies Codec<T.RuntimeSupport>;

const Via = z.enum(T.ViaValues) satisfies Codec<T.Via>;

const InstallationAvailable = z.object({
  status: z.literal("available"),
  via: Via,
  command: z.string(),
  version: z.string().nullable(),
}) satisfies Codec<T.InstallationAvailable>;

const InstallationNotFound = z.object({
  status: z.literal("not_found"),
}) satisfies Codec<T.InstallationNotFound>;

const InstallationChecking = z.object({
  status: z.literal("checking"),
}) satisfies Codec<T.InstallationChecking>;

const InstallationUnsupported = z.object({
  status: z.literal("unsupported"),
  reason: z.string(),
}) satisfies Codec<T.InstallationUnsupported>;

const Installation = z.discriminatedUnion("status", [
  InstallationAvailable,
  InstallationNotFound,
  InstallationChecking,
  InstallationUnsupported,
]) satisfies Codec<T.Installation>;

export const ModelEntry = z.object({
  id: z.string(),
  name: z.string(),
  effortLevels: z.array(z.string()),
  isDefault: z.boolean(),
}) satisfies Codec<T.ModelEntry>;

const UsageWindow = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
}) satisfies Codec<T.UsageWindow>;

const Balance = z.object({
  currency: z.string(),
  amount: z.number(),
}) satisfies Codec<T.Balance>;

const AccountUsageOk = z.object({
  status: z.literal("ok"),
  subscription: z.string().nullable(),
  windows: z.array(UsageWindow),
}) satisfies Codec<T.AccountUsageOk>;

const AccountUsageBalance = z.object({
  status: z.literal("balance"),
  provider: z.string(),
  available: z.boolean(),
  balances: z.array(Balance),
}) satisfies Codec<T.AccountUsageBalance>;

const AccountUsageLoginRequired = z.object({
  status: z.literal("login_required"),
}) satisfies Codec<T.AccountUsageLoginRequired>;

const AccountUsageUnavailable = z.object({
  status: z.literal("unavailable"),
  reason: z.string(),
}) satisfies Codec<T.AccountUsageUnavailable>;

const AccountUsage = z.discriminatedUnion("status", [
  AccountUsageOk,
  AccountUsageBalance,
  AccountUsageLoginRequired,
  AccountUsageUnavailable,
]) satisfies Codec<T.AccountUsage>;

const InventoryEntry = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(),
  enabled: z.boolean(),
}) satisfies Codec<T.InventoryEntry>;

export const RuntimeSettings = z.object({
  enabled: z.boolean(),
  binPath: z.string(),
  defaultModel: z.string(),
  defaultEffort: z.string(),
  env: z.record(z.string(), z.string()),
  dailyBudget: z.exactOptional(z.number()),
  maxWorking: z.exactOptional(z.number()),
}) satisfies Codec<T.RuntimeSettings>;

export const RuntimeInfo = z.object({
  id: z.string(),
  preset: RuntimePreset,
  support: RuntimeSupport,
  installation: Installation,
  models: z.array(ModelEntry).nullable(),
  usage: AccountUsage.nullable(),
  skills: z.array(InventoryEntry).nullable(),
  mcpServers: z.array(InventoryEntry).nullable(),
  tools: z.array(InventoryEntry).nullable(),
  settings: RuntimeSettings,
  spentToday: z.exactOptional(z.number()),
  quota: z.exactOptional(RuntimeQuota),
  stop: z.string(),
  checkedAt: z.number(),
}) satisfies Codec<T.RuntimeInfo>;
