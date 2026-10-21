// What the title's menu offers: whether there is a farm to go back to, and whether the manager can think.

import type { CoreState, SettingsStatus } from "@vibevalley/protocol";

/** 继续游戏 needs a farm to go back to: a helper, a word said, or a coin earned. */
export const hasFarm = (core: CoreState | undefined) =>
  !!core && (core.sessions.length > 0 || (core.chat?.messages.length ?? 0) > 0 || (core.progress?.coins ?? 0) > 0);

/** The manager cannot think without DeepSeek's key. */
export const managerReady = (status: SettingsStatus | undefined) => status?.deepseekApiKey.source !== undefined;
