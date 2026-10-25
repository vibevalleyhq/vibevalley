// The farm's own models, as pi-ai Models: VibeValley's agent talks to them through pi-ai, and
// the farm prices its agent's and DeepSeek Harness's runs by them. pi-ai's built-in list has its own DeepSeek entries,
// with other prices; the farm's are these.

import type { Model } from "@earendil-works/pi-ai";

const deepseek = (id: string, name: string, cost: Model<"openai-completions">["cost"]): Model<"openai-completions"> => ({
  id,
  name,
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  input: ["text"],
  cost,
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  thinkingLevelMap: {
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  },
  compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
});

/** Prices in dollars per million tokens. */
export const models: readonly Model<"openai-completions">[] = [
  deepseek("deepseek-flash", "DeepSeek V4.1 Flash", {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.028,
    cacheWrite: 0,
  }),
  deepseek("deepseek-v4-pro", "DeepSeek V4 Pro", {
    input: 1.74,
    output: 3.48,
    cacheRead: 0.145,
    cacheWrite: 0,
  }),
];

export const getModel = (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id);
