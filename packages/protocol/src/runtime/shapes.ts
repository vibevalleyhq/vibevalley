export * from "./shapes.gen";

export const sessionSystemPrompt = "systemPrompt";

export const sessionAppendSystemPrompt = "appendSystemPrompt";

export const sessionEffort = "effort";

export const sessionEnv = "env";

export const sessionMcpServers = "mcpServers";

export const sessionDisallowedTools = "disallowedTools";

/** The percent of a window still left below which a runtime is nearly out of quota: the farm warns, and the
 * orchestrator sends someone else if it can. */
export const quotaLow = 15;
