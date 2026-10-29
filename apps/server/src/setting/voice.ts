import { currentLocale, t } from "@vibevalley/i18n";
import { voiceOrchestratorPersona } from "./prompts.ts";
import {
  type SettingsUpdateVoice,
  voiceIdleSecondsMax,
  voiceIdleSecondsMin,
  voiceInterruptMsMax,
  voiceInterruptMsMin,
  type VoiceSettings,
  voiceSilenceMsMax,
  voiceSilenceMsMin,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import { voiceURL } from "./keys.ts";
const limits = {
  silenceMs: [voiceSilenceMsMin, voiceSilenceMsMax],
  interruptMs: [voiceInterruptMsMin, voiceInterruptMsMax],
  idleSeconds: [voiceIdleSecondsMin, voiceIdleSecondsMax],
} as const;

export function voiceProblem(v: SettingsUpdateVoice): string {
  if (v.asr?.vendor === "microsoft" && v.asr.region.trim() === "") return t("server.setting.voice.region");
  const answer = v.answer;
  if (answer?.vendor === "deepseek" && answer.model.trim() === "") return t("server.setting.voice.model");
  if (answer?.vendor === "openai") {
    if (answer.model.trim() === "") return t("server.setting.voice.model");
    if (!voiceURL.test(answer.url.trim())) return t("server.setting.voice.url");
  }
  const tts = v.tts;
  if (tts?.vendor === "minimax" && tts.voiceId.trim() === "") return t("server.setting.voice.voiceId");
  if (tts?.vendor === "microsoft" && (tts.region.trim() === "" || tts.voiceName.trim() === "")) return t("server.setting.voice.microsoft");
  if (v.persona !== undefined && v.persona.trim() === "") return t("server.setting.voice.persona");
  for (const key of ["silenceMs", "interruptMs", "idleSeconds"] as const) {
    const n = v[key];
    const [min, max] = limits[key];
    if (n !== undefined && (n < min || n > max)) return t("server.setting.voice.range", { label: t(`server.setting.voice.label.${key}`), min, max });
  }
  return "";
}

const voiceKeys = ["area", "language", "asr", "answer", "tts", "persona", "greeting", "failureMessage", "silenceMs", "interruptMs", "idleSeconds"] as const;

export function voiceSettingsOver(defaults: VoiceSettings, overrides: SettingsUpdateVoice): VoiceSettings {
  const out: VoiceSettings = { ...defaults };
  const take = <K extends (typeof voiceKeys)[number]>(key: K) => {
    const value = overrides[key];
    if (value !== undefined) out[key] = value;
  };
  for (const key of voiceKeys) take(key);
  return out;
}

export function voiceOverrides(defaults: VoiceSettings, settings: VoiceSettings): SettingsUpdateVoice {
  const out: Record<string, unknown> = {};
  for (const key of voiceKeys) if (!same(settings[key], defaults[key])) out[key] = settings[key];
  return out;
}

export const defaultVoice = (): VoiceSettings => ({
  area: "US",
  language: currentLocale() === "zh" ? "zh-CN" : "en-US",
  asr: { vendor: "ares" },
  // As the chat's voice/voice.ts: the farm's own orchestrator answers, so change the two together.
  answer: { vendor: "orchestrator" },
  tts: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  persona: voiceOrchestratorPersona(),
  greeting: t("shared.greeting"),
  failureMessage: t("server.setting.defaults.failureMessage"),
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
});
