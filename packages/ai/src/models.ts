// The farm's own models: VibeValley's agent talks to them (llm.ts), and the farm prices its agent's and DeepSeek
// Harness's runs by them. pi-ai's built-in list has its own DeepSeek entries, with other prices; the farm's are these.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The order pi-ai clamps a level in: a level a model lacks becomes the next one up, else the next one down. */
const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly api: "openai-completions";
  readonly provider: "deepseek";
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  /** Dollars per million tokens. */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** What a level is sent as (reasoning_effort): a level not here goes as itself; null means the model has no such level,
   * and off null means thinking cannot be turned off. */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}

const deepseek = (id: string, name: string, cost: Model["cost"]): Model => ({
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
  thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
});

export const models: readonly Model[] = [
  deepseek("deepseek-flash", "DeepSeek V4.1 Flash", { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }),
  deepseek("deepseek-v4-pro", "DeepSeek V4 Pro", { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 }),
];

export const getModel = (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id);

/** As pi-ai's clampThinkingLevel. */
export function clampThinkingLevel(model: Model, level: ThinkingLevel): ThinkingLevel {
  const offered: readonly ThinkingLevel[] = model.reasoning
    ? thinkingLevels.filter((l) => {
        const mapped = model.thinkingLevelMap?.[l];
        if (mapped === null) return false;
        return l === "xhigh" || l === "max" ? mapped !== undefined : true;
      })
    : ["off"];
  if (offered.includes(level)) return level;
  const at = thinkingLevels.indexOf(level);
  for (let i = at; i < thinkingLevels.length; i++) if (offered.includes(thinkingLevels[i]!)) return thinkingLevels[i]!;
  for (let i = at - 1; i >= 0; i--) if (offered.includes(thinkingLevels[i]!)) return thinkingLevels[i]!;
  return offered[0] ?? "off";
}
