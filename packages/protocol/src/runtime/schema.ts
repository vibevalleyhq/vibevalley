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

export const RuntimeCapability = z.enum(T.RuntimeCapabilityValues) satisfies Codec<T.RuntimeCapability>;

export const RuntimeSupport = z.object({
  steer: z.boolean(),
  refused: z.record(z.string(), z.string()),
  capabilities: z.array(RuntimeCapability),
  inProcess: z.boolean(),
  inSessionConfig: z.exactOptional(z.boolean()),
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
  signInCommand: z.exactOptional(z.string()),
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
  defaultEffort: z.exactOptional(z.string()),
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
  machineId: z.exactOptional(z.string()),
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

export const McpHostId = z.enum(T.McpHostIdValues) satisfies Codec<T.McpHostId>;

export const McpTransportKind = z.enum(T.McpTransportKindValues) satisfies Codec<T.McpTransportKind>;

const McpInstallStatusNotInstalled = z.object({
  kind: z.literal("notInstalled"),
});

const McpInstallStatusInstalled = z.object({
  kind: z.literal("installed"),
  transport: McpTransportKind,
});

const McpInstallStatusOutdated = z.object({
  kind: z.literal("outdated"),
  current: McpTransportKind,
  reason: z.string(),
});

const McpInstallStatusUnsupported = z.object({
  kind: z.literal("unsupported"),
  reason: z.string(),
});

export const McpInstallStatus = z.discriminatedUnion("kind", [
  McpInstallStatusNotInstalled,
  McpInstallStatusInstalled,
  McpInstallStatusOutdated,
  McpInstallStatusUnsupported,
]) satisfies Codec<T.McpInstallStatus>;

export const McpHostInfo = z.object({
  id: McpHostId,
  label: z.string(),
  installed: z.boolean(),
  configPath: z.exactOptional(z.string()),
  status: McpInstallStatus,
  supportsStdio: z.boolean(),
  supportsHttp: z.boolean(),
  stdioSnippet: z.string(),
  httpSnippet: z.exactOptional(z.string()),
}) satisfies Codec<T.McpHostInfo>;

export const McpListInput = z.object({
  transport: z.exactOptional(McpTransportKind),
}) satisfies Codec<T.McpListInput>;

export const McpListResult = z.object({
  serverName: z.string(),
  stdioCommand: z.string(),
  stdioArgs: z.array(z.string()),
  httpUrl: z.exactOptional(z.string()),
  hosts: z.array(McpHostInfo),
}) satisfies Codec<T.McpListResult>;

export const McpInstallInput = z.object({
  host: McpHostId,
  transport: z.exactOptional(McpTransportKind),
}) satisfies Codec<T.McpInstallInput>;

export const McpUninstallInput = z.object({
  host: McpHostId,
}) satisfies Codec<T.McpUninstallInput>;

export const McpServerEntry = z.object({
  host: McpHostId,
  name: z.string(),
  transport: McpTransportKind,
  command: z.exactOptional(z.string()),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  url: z.exactOptional(z.string()),
  headers: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  configPath: z.string(),
}) satisfies Codec<T.McpServerEntry>;

export const McpServerListInput = z.object({
  host: McpHostId,
}) satisfies Codec<T.McpServerListInput>;

export const McpServerListResult = z.object({
  host: McpHostId,
  configPath: z.exactOptional(z.string()),
  servers: z.array(McpServerEntry),
}) satisfies Codec<T.McpServerListResult>;

export const McpServerSaveInput = z.object({
  host: McpHostId,
  previousName: z.exactOptional(z.string()),
  name: z.string(),
  transport: McpTransportKind,
  command: z.exactOptional(z.string()),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  url: z.exactOptional(z.string()),
  headers: z.record(z.string(), z.string()),
  enabled: z.boolean(),
}) satisfies Codec<T.McpServerSaveInput>;

export const McpServerToggleInput = z.object({
  host: McpHostId,
  name: z.string(),
  enabled: z.boolean(),
}) satisfies Codec<T.McpServerToggleInput>;

export const McpServerRemoveInput = z.object({
  host: McpHostId,
  name: z.string(),
}) satisfies Codec<T.McpServerRemoveInput>;
