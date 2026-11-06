import { Schema } from "effect";

import { Look } from "../agent/schema";
import type { Codec } from "../codec";
import * as T from "../shapes";

export const RuntimeQuota: Codec<T.RuntimeQuota> = Schema.Struct({
  left: Schema.optionalKey(Schema.Finite),
  text: Schema.String,
});

export const RuntimePreset: Codec<T.RuntimePreset> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  blurb: Schema.String,
  look: Look,
});

export const RuntimeCapability: Codec<T.RuntimeCapability> = Schema.Literals(T.RuntimeCapabilityValues);

export const RuntimeSupport: Codec<T.RuntimeSupport> = Schema.Struct({
  steer: Schema.Boolean,
  refused: Schema.Record(Schema.String, Schema.String),
  capabilities: Schema.mutable(Schema.Array(RuntimeCapability)),
  inProcess: Schema.Boolean,
});

export const Via: Codec<T.Via> = Schema.Literals(T.ViaValues);

export const InstallationAvailable: Codec<T.InstallationAvailable> = Schema.Struct({
  status: Schema.Literal("available"),
  via: Via,
  command: Schema.String,
  version: Schema.NullOr(Schema.String),
});

export const InstallationNotFound: Codec<T.InstallationNotFound> = Schema.Struct({
  status: Schema.Literal("not_found"),
});

export const InstallationChecking: Codec<T.InstallationChecking> = Schema.Struct({
  status: Schema.Literal("checking"),
});

export const InstallationUnsupported: Codec<T.InstallationUnsupported> = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: Schema.String,
});

export const Installation: Codec<T.Installation> = Schema.Union([InstallationAvailable, InstallationNotFound, InstallationChecking, InstallationUnsupported]);

export const ModelEntry: Codec<T.ModelEntry> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  effortLevels: Schema.mutable(Schema.Array(Schema.String)),
  isDefault: Schema.Boolean,
});

export const UsageWindow: Codec<T.UsageWindow> = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.Finite),
});

export const Balance: Codec<T.Balance> = Schema.Struct({
  currency: Schema.String,
  amount: Schema.Finite,
});

export const AccountUsageOk: Codec<T.AccountUsageOk> = Schema.Struct({
  status: Schema.Literal("ok"),
  subscription: Schema.NullOr(Schema.String),
  windows: Schema.mutable(Schema.Array(UsageWindow)),
});

export const AccountUsageBalance: Codec<T.AccountUsageBalance> = Schema.Struct({
  status: Schema.Literal("balance"),
  provider: Schema.String,
  available: Schema.Boolean,
  balances: Schema.mutable(Schema.Array(Balance)),
});

export const AccountUsageLoginRequired: Codec<T.AccountUsageLoginRequired> = Schema.Struct({
  status: Schema.Literal("login_required"),
});

export const AccountUsageUnavailable: Codec<T.AccountUsageUnavailable> = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
});

export const AccountUsage: Codec<T.AccountUsage> = Schema.Union([AccountUsageOk, AccountUsageBalance, AccountUsageLoginRequired, AccountUsageUnavailable]);

export const InventoryEntry: Codec<T.InventoryEntry> = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: Schema.String,
  enabled: Schema.Boolean,
});

export const RuntimeSettings: Codec<T.RuntimeSettings> = Schema.Struct({
  enabled: Schema.Boolean,
  binPath: Schema.String,
  defaultModel: Schema.String,
  defaultEffort: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  dailyBudget: Schema.optionalKey(Schema.Finite),
  maxWorking: Schema.optionalKey(Schema.Finite),
});

export const RuntimeInfo: Codec<T.RuntimeInfo> = Schema.Struct({
  id: Schema.String,
  preset: RuntimePreset,
  support: RuntimeSupport,
  installation: Installation,
  models: Schema.NullOr(Schema.mutable(Schema.Array(ModelEntry))),
  usage: Schema.NullOr(AccountUsage),
  skills: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  mcpServers: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  tools: Schema.NullOr(Schema.mutable(Schema.Array(InventoryEntry))),
  settings: RuntimeSettings,
  spentToday: Schema.optionalKey(Schema.Finite),
  quota: Schema.optionalKey(RuntimeQuota),
  stop: Schema.String,
  checkedAt: Schema.Finite,
});
