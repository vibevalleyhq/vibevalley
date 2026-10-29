import { t } from "@vibevalley/i18n";

/** The model id it answers as, on the voice line and on chatCompletionsPath alike. */
export const orchestratorModel = "vibevalley-orchestrator";

export const chatCompletionsPath = "/v1/chat/completions";

/** The orchestrator answers only on DeepSeek: its profile's model as DeepSeek names it. */
export function deepseekModel(configured: string, fallback: string): string {
  if (configured === "") return fallback;
  const slash = configured.indexOf("/");
  if (slash < 0) return configured;
  if (configured.slice(0, slash) === "deepseek") return configured.slice(slash + 1);
  throw new Error(t("server.orchestrator.onlyDeepseek", { configured }));
}
