export interface DeepSeekModel {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  /** Dollars per million tokens. */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: Readonly<Partial<Record<string, string | null>>>;
}

const model = (id: string, name: string, cost: DeepSeekModel["cost"]): DeepSeekModel => ({
  id,
  name,
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  input: ["text"],
  cost,
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
});

export const deepseekModels: readonly [DeepSeekModel, ...DeepSeekModel[]] = [
  model("deepseek-flash", "DeepSeek V4.1 Flash", { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }),
  model("deepseek-v4-pro", "DeepSeek V4 Pro", { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 }),
];
