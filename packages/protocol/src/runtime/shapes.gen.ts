// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { Look } from "../agent/shapes.gen";

export type RuntimeQuota = { left?: number, text: string, };

export type RuntimePreset = { id: string, label: string, blurb: string, look: Look, };

export const RuntimeCapabilityValues = ["listModels", "accountUsage", "checkUpdate", "upgrade", "skills", "mcpServers", "tools"] as const;
export type RuntimeCapability = (typeof RuntimeCapabilityValues)[number];

export type RuntimeSupport = { steer: boolean, refused: { [key in string]: string }, capabilities: Array<RuntimeCapability>, inProcess: boolean, };

export const ViaValues = ["executable", "bundled"] as const;
export type Via = (typeof ViaValues)[number];

export type InstallationAvailable = { "status": "available", via: Via, command: string, version: string | null, };

export type InstallationNotFound = { "status": "not_found", };

export type InstallationChecking = { "status": "checking", };

export type InstallationUnsupported = { "status": "unsupported", reason: string, signInCommand?: string, };

/**
 * Told apart by `status`.
 */
export type Installation = InstallationAvailable | InstallationNotFound | InstallationChecking | InstallationUnsupported;

export type ModelEntry = { id: string, name: string, effortLevels: Array<string>, isDefault: boolean, };

export type UsageWindow = { label: string, usedPercent: number, resetsAt: number | null, };

export type Balance = { currency: string, amount: number, };

export type AccountUsageOk = { "status": "ok", subscription: string | null, windows: Array<UsageWindow>, };

export type AccountUsageBalance = { "status": "balance", provider: string, available: boolean, balances: Array<Balance>, };

export type AccountUsageLoginRequired = { "status": "login_required", };

export type AccountUsageUnavailable = { "status": "unavailable", reason: string, };

/**
 * Told apart by `status`.
 */
export type AccountUsage = AccountUsageOk | AccountUsageBalance | AccountUsageLoginRequired | AccountUsageUnavailable;

export type InventoryEntry = { name: string, description: string, source: string, enabled: boolean, };

export type RuntimeSettings = { enabled: boolean, binPath: string, defaultModel: string, defaultEffort: string, env: { [key in string]: string }, dailyBudget?: number, maxWorking?: number, };

export type RuntimeInfo = { id: string, preset: RuntimePreset, support: RuntimeSupport, installation: Installation, models: Array<ModelEntry> | null, usage: AccountUsage | null, skills: Array<InventoryEntry> | null, mcpServers: Array<InventoryEntry> | null, tools: Array<InventoryEntry> | null, settings: RuntimeSettings, spentToday?: number, quota?: RuntimeQuota, stop: string, checkedAt: number, };

export type RuntimeRefreshInput = { id: string, };

export type RuntimeSettingUpdateInput = { id: string, enabled: boolean, binPath: string, defaultModel: string, defaultEffort: string, env: { [key in string]: string }, dailyBudget?: number, maxWorking?: number, };
