// The shapes of the coding agents on this machine: presets, what each supports, installation, usage (docs/subsystems/agent.md).

import type { Look } from "../agent/shapes";

export const sessionSystemPrompt = "systemPrompt";

export const sessionAppendSystemPrompt = "appendSystemPrompt";

export const sessionEffort = "effort";

export const sessionEnv = "env";

export const sessionMcpServers = "mcpServers";

export const sessionDisallowedTools = "disallowedTools";

/** The percent of a window still left below which a runtime is nearly out of quota: the farm warns, and the
 * orchestrator sends someone else if it can. */
export const quotaLow = 15;

export interface RuntimeQuota {
  left?: number;
  text: string;
}

export interface RuntimePreset {
  id: string;
  label: string;
  blurb: string;
  look: Look;
}

export interface RuntimeSupport {
  steer: boolean;
  refused: Record<string, string>;
  capabilities: RuntimeCapability[];
  inProcess: boolean;
}

export const RuntimeCapabilityValues = ["listModels", "accountUsage", "checkUpdate", "upgrade", "skills", "mcpServers", "tools"] as const;
export type RuntimeCapability = (typeof RuntimeCapabilityValues)[number];

/** Told apart by `status`. */
export type Installation = InstallationAvailable | InstallationNotFound | InstallationChecking | InstallationUnsupported;

export interface ModelEntry {
  id: string;
  name: string;
  effortLevels: string[];
  isDefault: boolean;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface Balance {
  currency: string;
  amount: number;
}

/** Told apart by `status`. */
export type AccountUsage = AccountUsageOk | AccountUsageBalance | AccountUsageLoginRequired | AccountUsageUnavailable;

export interface InventoryEntry {
  name: string;
  description: string;
  source: string;
  enabled?: boolean;
}

export interface RuntimeSettings {
  enabled: boolean;
  binPath: string;
  defaultModel: string;
  defaultEffort: string;
  env: Record<string, string>;
  dailyBudget?: number;
  maxWorking?: number;
}

export interface RuntimeInfo {
  id: string;
  preset: RuntimePreset;
  support: RuntimeSupport;
  installation: Installation;
  models: ModelEntry[] | null;
  usage: AccountUsage | null;
  skills: InventoryEntry[] | null;
  mcpServers: InventoryEntry[] | null;
  tools: InventoryEntry[] | null;
  settings: RuntimeSettings;
  spentToday?: number;
  quota?: RuntimeQuota;
  stop: string;
  checkedAt: number;
}

export const ViaValues = ["executable", "bundled"] as const;
export type Via = (typeof ViaValues)[number];

export interface InstallationAvailable {
  status: "available";
  via: Via;
  command: string;
  version: string | null;
}

export interface InstallationNotFound {
  status: "not_found";
}

export interface InstallationChecking {
  status: "checking";
}

export interface InstallationUnsupported {
  status: "unsupported";
  reason: string;
}

export interface AccountUsageOk {
  status: "ok";
  subscription: string | null;
  windows: UsageWindow[];
}

export interface AccountUsageBalance {
  status: "balance";
  provider: string;
  available: boolean;
  balances: Balance[];
}

export interface AccountUsageLoginRequired {
  status: "login_required";
}

export interface AccountUsageUnavailable {
  status: "unavailable";
  reason: string;
}
