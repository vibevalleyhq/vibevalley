import { t } from "@vibevalley/i18n";

import { type SettingsUpdate } from "@vibevalley/protocol";

import { memorySourcesProblem } from "./memorySources.ts";
import { agoraID, hasSpace, voiceURL } from "./keys.ts";
import { voiceProblem } from "./voice.ts";
/** Empty strings clear and are always fine. */
export function settingsProblem(u: SettingsUpdate): string {
  const trimmed = (s: string | undefined) => (s ?? "").trim();
  const deepseek = trimmed(u.deepseekApiKey);
  if (deepseek !== "" && (hasSpace(deepseek) || deepseek.length < 8)) return t("server.setting.deepseekKey");
  const appID = trimmed(u.agoraAppId);
  if (appID !== "" && !agoraID.test(appID)) return t("server.setting.agoraId");
  const certificate = trimmed(u.agoraAppCertificate);
  if (certificate !== "" && !agoraID.test(certificate)) return t("server.setting.agoraCertificate");
  for (const key of [u.asrKey, u.llmKey, u.ttsKey, u.dictationKey, u.mossKey]) if (hasSpace(trimmed(key))) return t("server.setting.voiceKeySpace");
  const d = u.dictation;
  if (d?.via === "own" && d.url.trim() !== "") {
    if (!voiceURL.test(d.url.trim())) return t("server.setting.dictationUrl");
    if (d.model.trim() === "") return t("server.setting.dictationModel");
  }
  const sources = memorySourcesProblem(u.memorySources ?? []);
  if (sources) return sources;
  return u.voice ? voiceProblem(u.voice) : "";
}
