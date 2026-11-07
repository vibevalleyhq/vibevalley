import { type DeepSeekModel, deepseekModels } from "@vibevalley/provider/deepseek/models";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The order pi-ai clamps a level in: a level a model lacks becomes the next one up, else the next one down. */
const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface Model extends DeepSeekModel {
  readonly api: "openai-completions";
  readonly provider: "deepseek";
  /** What a level is sent as (reasoning_effort): a level not here goes as itself. */
  readonly thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}

const modelOf = (model: DeepSeekModel): Model => ({ ...model, api: "openai-completions", provider: "deepseek" });
const [first, ...rest] = deepseekModels;
export const models: readonly [Model, ...Model[]] = [modelOf(first), ...rest.map(modelOf)];

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
  return thinkingLevels.slice(at).find((l) => offered.includes(l)) ?? thinkingLevels.slice(0, at).findLast((l) => offered.includes(l)) ?? offered[0] ?? "off";
}
