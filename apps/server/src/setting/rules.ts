// What settings may be saved, and how the voice keeps only what differs from its defaults
//.

import {
  defaultGreeting,
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
  if (deepseek !== "" && (hasSpace(deepseek) || deepseek.length < 8)) return "DeepSeek 的 API Key 看着不对：一串不带空格的字，通常以 sk- 开头";
  const appID = trimmed(u.agoraAppId);
  if (appID !== "" && !agoraID.test(appID)) return "Agora 的 App ID 是 32 位的十六进制，在声网控制台的项目里找";
  const certificate = trimmed(u.agoraAppCertificate);
  if (certificate !== "" && !agoraID.test(certificate)) return "Agora 的 App Certificate 是 32 位的十六进制，在声网控制台的项目里找";
  for (const key of [u.asrKey, u.llmKey, u.ttsKey, u.dictationKey]) if (hasSpace(trimmed(key))) return "语音服务的 key 里不该有空格";
  const d = u.dictation;
  if (d && d.url.trim() !== "") {
    if (!voiceURL.test(d.url.trim())) return "听写的地址要是 http(s) 开头的完整地址，到 /v1 为止，比如本机的 http://127.0.0.1:8080/v1";
    if (d.model.trim() === "") return "听写要填模型名，比如本机 speech-server 的 qwen3，或 OpenAI 的 gpt-4o-mini-transcribe";
  }
  const sources = memorySourcesProblem(u.memorySources ?? []);
  if (sources) return sources;
  return u.voice ? voiceProblem(u.voice) : "";
}

export function memorySourcesProblem(sources: readonly MemorySourceUpdate[]): string {
  const seen = new Set<string>();
  for (const m of sources) {
    if (!(MemorySourceKindValues as readonly string[]).includes(m.kind)) return "不认识的记性来源：" + m.kind;
    if (seen.has(m.kind)) return "同一种记性来源只能接一个：" + m.kind;
    seen.add(m.kind);
    const url = m.url.trim();
    if (m.enabled && url === "") return "要接上记性来源，先填它的地址";
    if (url !== "" && !voiceURL.test(url)) return "记性来源的地址要是 http(s) 开头的完整地址，比如 Nowledge Mem 的 http://127.0.0.1:14242/mcp/";
    if (m.key !== undefined && hasSpace(m.key.trim())) return "记性来源的 key 里不该有空格";
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

const labels: Record<keyof typeof limits, string> = {
  silenceMs: "停顿多久算说完（毫秒）",
  interruptMs: "说多久能打断他（毫秒）",
  idleSeconds: "没人时多久离开（秒）",
};

export function voiceProblem(v: SettingsUpdateVoice): string {
  if (v.asr?.vendor === "microsoft" && v.asr.region.trim() === "") return "微软识别要填区域，比如 eastasia";
  const answer = v.answer;
  if (answer?.vendor === "deepseek" && answer.model.trim() === "") return "大模型要填模型名";
  if (answer?.vendor === "openai") {
    if (answer.model.trim() === "") return "大模型要填模型名";
    if (!voiceURL.test(answer.url.trim())) return "大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions";
  }
  const tts = v.tts;
  if (tts?.vendor === "minimax" && tts.voiceId.trim() === "") return "音色不能空着：选一个或填 MiniMax 的音色 id";
  if (tts?.vendor === "microsoft" && (tts.region.trim() === "" || tts.voiceName.trim() === "")) return "微软合成要填区域和音色名";
  if (v.persona !== undefined && v.persona.trim() === "") return "管家的人设不能空着";
  for (const key of ["silenceMs", "interruptMs", "idleSeconds"] as const) {
    const n = v[key];
    const [min, max] = limits[key];
    if (n !== undefined && (n < min || n > max)) return `${labels[key]}要在 ${min} 到 ${max} 之间`;
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
  return out as SettingsUpdateVoice;
}

// The voice line's defaults.
const voiceAssistantPersona = `你是码农场物语的管家，一个和气、利落的年轻农夫。农场里的帮工是一群小动物，它们其实是写代码的 AI：后端老周（熊）、测试小吴（兔子）、前端阿郑（小狐狸）、文档员 Kimi（猫）、情报 Grok（猫头鹰）、Pi 实验员（刺猬）、夜班反重力（浣熊）。

主人跟你说要做什么活，你就简短确认会派给谁去做，比如「好，让测试小吴去跑一遍测试」。派活和进度由农场自己处理，你看不到地里的实时情况，不要编造进度、结果或文件名；被问到进度时，就说可以看地里的牌子或者日志。

这是语音对话：每次只说一两句，口语化，不列清单，不用 markdown。一次最多问一个问题。用中文回答。`;

export const defaultVoice = (): VoiceSettings => ({
  area: "US",
  language: "zh-CN",
  asr: { vendor: "ares" },
  // The farm's own assistant answers: the call is its mouth, with the same conversation as 田头 (voice/voice.ts, the line).
  answer: { vendor: "assistant" },
  tts: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  persona: voiceAssistantPersona,
  greeting: defaultGreeting,
  failureMessage: "我这边卡了一下，你再说一遍？",
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
});
