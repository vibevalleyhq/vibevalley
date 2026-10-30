// The model a farm agent talks to: agent/brain's deepseek, with a missing key said to the owner.

import { deepseek, MissingKey, type ModelClient } from "@vibevalley/ai/client";
import type { Llm } from "@vibevalley/ai/llm";
import { t } from "@vibevalley/i18n";

/** Where to put a key, in the owner's words. */
export const noDeepSeekKey = () => t("server.agent.noDeepSeekKey");

export function modelClient(id: string, key: string | (() => string | undefined), service: Llm["Service"]): ModelClient {
  try {
    return deepseek(id, key, service);
  } catch (e) {
    if (e instanceof MissingKey) throw new Error(noDeepSeekKey(), { cause: e });
    throw e;
  }
}
