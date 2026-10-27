// What the title's menu offers: whether there is a farm to go back to, and whether the orchestrator can think.

import type { WorkspaceState, SettingsStatus } from "@vibevalley/protocol";

/** 继续游戏 needs a farm to go back to: a helper, a word said, or a coin earned. */
export const hasFarm = (core: WorkspaceState | undefined) =>
  !!core && (core.sessions.length > 0 || (core.chat?.channels ?? []).some((c) => (c.lastNumber ?? 0) > 0) || (core.progress?.coins ?? 0) > 0);

/** The orchestrator cannot think without DeepSeek's key. */
export const orchestratorReady = (status: SettingsStatus | undefined) => status?.deepseekApiKey.source !== undefined;
