import { t } from "@vibevalley/i18n";
// The model a farm agent talks to: agent/brain's deepseek, with a missing key said to the owner.

import type { LlmShape } from "../ai/llm.ts";
import { deepseek, type LLM, MissingKey } from "./brain/config.ts";

/** Where to put a key, in the owner's words. */
export const noDeepSeekKey = () => t("server.agent.noDeepSeekKey");

export function modelClient(id: string, key: string | (() => string | undefined), service: LlmShape): LLM {
  try {
    return deepseek(id, key, service);
  } catch (e) {
    if (e instanceof MissingKey) throw new Error(noDeepSeekKey(), { cause: e });
    throw e;
  }
}
