import { currentLocale, t } from "@vibevalley/i18n";
// What settings may be saved, and how the voice keeps only what differs from its defaults
//.

import { voiceOrchestratorPersona } from "./prompts.ts";
import {
  MemorySourceKindValues,
  type MemorySourceUpdate,
  type SettingsUpdate,
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

/** A memory source as settings.json keeps it, with its key: read together, so an address is never paired with another one's key. */
export interface MemorySourceConfig {
  readonly kind: MemorySourceUpdate["kind"];
  readonly url: string;
  readonly enabled?: boolean;
  readonly read?: boolean;
  readonly write?: boolean;
  readonly everything?: boolean;
  readonly user?: string;
  readonly key?: string;
}

export const keyHint = (key: string) => "…" + key.slice(-4);

const agoraID = /^[0-9a-fA-F]{32}$/;
export const voiceURL = /^https?:\/\/\S+$/;

const hasSpace = (s: string) => /\s/.test(s);

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
  if (d && d.url.trim() !== "") {
    if (!voiceURL.test(d.url.trim())) return t("server.setting.dictationUrl");
    if (d.model.trim() === "") return t("server.setting.dictationModel");
  }
  const sources = memorySourcesProblem(u.memorySources ?? []);
  if (sources) return sources;
  return u.voice ? voiceProblem(u.voice) : "";
}

export function memorySourcesProblem(sources: readonly MemorySourceUpdate[]): string {
  const seen = new Set<string>();
  for (const m of sources) {
    if (!(MemorySourceKindValues as readonly string[]).includes(m.kind)) return t("server.setting.memory.unknown", { kind: m.kind });
    if (seen.has(m.kind)) return t("server.setting.memory.twice", { kind: m.kind });
    seen.add(m.kind);
    const url = m.url.trim();
    if (m.enabled && url === "") return t("server.setting.memory.noUrl");
    if (url !== "" && !voiceURL.test(url)) return t("server.setting.memory.url");
    if (m.key !== undefined && hasSpace(m.key.trim())) return t("server.setting.memory.keySpace");
  }
  return "";
}

/** The list given replaces the saved one; a source given without a key keeps the key saved for its kind. */
export function memorySourcesOver(saved: readonly MemorySourceConfig[], given: readonly MemorySourceUpdate[]): MemorySourceConfig[] {
  return given.map((m) => {
    const key = m.key !== undefined ? m.key.trim() : saved.find((c) => c.kind === m.kind)?.key;
    return {
      kind: m.kind,
      url: m.url.trim(),
      ...(m.enabled ? { enabled: true } : {}),
      ...(m.read ? { read: true } : {}),
      ...(m.write ? { write: true } : {}),
      ...(m.everything ? { everything: true } : {}),
      ...(m.user?.trim() ? { user: m.user.trim() } : {}),
      ...(key ? { key } : {}),
    };
  });
}

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
  const out: Record<string, unknown> = { ...defaults };
  for (const key of voiceKeys) if (overrides[key] !== undefined) out[key] = overrides[key];
  return out as unknown as VoiceSettings;
}

/** Only what differs. */
export function voiceOverrides(defaults: VoiceSettings, settings: VoiceSettings): SettingsUpdateVoice {
  const out: Record<string, unknown> = {};
  for (const key of voiceKeys) if (!same(settings[key], defaults[key])) out[key] = settings[key];
  return out;
}

export const defaultVoice = (): VoiceSettings => ({
  area: "US",
  language: currentLocale() === "zh" ? "zh-CN" : "en-US",
  asr: { vendor: "ares" },
  // The farm's own orchestrator answers: the call is its mouth, answering as it does in the chat (voice/voice.ts, the line).
  answer: { vendor: "orchestrator" },
  tts: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  persona: voiceOrchestratorPersona(),
  greeting: t("shared.greeting"),
  failureMessage: t("server.setting.defaults.failureMessage"),
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
});
