// What the settings say to the owner: why a value is refused, and the voice line's defaults in the owner's language
// (what it says when it stumbles, the language it listens in; its greeting is the protocol's).

import type { Language } from "@vibevalley/protocol";
import { localized } from "@vibevalley/protocol/words";

const zh = {
  deepseekKey: "DeepSeek 的 API Key 看着不对：一串不带空格的字，通常以 sk- 开头",
  agoraId: "Agora 的 App ID 是 32 位的十六进制，在声网控制台的项目里找",
  agoraCertificate: "Agora 的 App Certificate 是 32 位的十六进制，在声网控制台的项目里找",
  voiceKeySpace: "语音服务的 key 里不该有空格",
  dictationUrl: "听写的地址要是 http(s) 开头的完整地址，到 /v1 为止，比如本机的 http://127.0.0.1:8080/v1",
  dictationModel: "听写要填模型名，比如本机 speech-server 的 qwen3，或 OpenAI 的 gpt-4o-mini-transcribe",
  memory: {
    unknown: (kind: string) => "不认识的记性来源：" + kind,
    twice: (kind: string) => "同一种记性来源只能接一个：" + kind,
    noUrl: "要接上记性来源，先填它的地址",
    url: "记性来源的地址要是 http(s) 开头的完整地址，比如 Nowledge Mem 的 http://127.0.0.1:14242/mcp/",
    keySpace: "记性来源的 key 里不该有空格",
  },
  voice: {
    label: { silenceMs: "停顿多久算说完（毫秒）", interruptMs: "说多久能打断他（毫秒）", idleSeconds: "没人时多久离开（秒）" },
    range: (label: string, min: number, max: number) => `${label}要在 ${min} 到 ${max} 之间`,
    region: "微软识别要填区域，比如 eastasia",
    model: "大模型要填模型名",
    url: "大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions",
    voiceId: "音色不能空着：选一个或填 MiniMax 的音色 id",
    microsoft: "微软合成要填区域和音色名",
    persona: "管家的人设不能空着",
  },
  /** The voice line's defaults: the language it listens in, what it says first and when it stumbles. */
  defaults: { language: "zh-CN" as Language, failureMessage: "我这边卡了一下，你再说一遍？" },
  notSaved: (file: string, why: string) => `存不进 ${file}：${why}`,
};

const en: typeof zh = {
  deepseekKey: "The DeepSeek API Key does not look right: a string with no spaces, usually starting with sk-",
  agoraId: "Agora's App ID is 32 hexadecimal digits: find it in your project on Agora's console",
  agoraCertificate: "Agora's App Certificate is 32 hexadecimal digits: find it in your project on Agora's console",
  voiceKeySpace: "A voice service's key should have no spaces",
  dictationUrl: "The dictation address is a full address starting with http(s), up to /v1, such as http://127.0.0.1:8080/v1 on this machine",
  dictationModel: "Dictation needs a model name, such as qwen3 for a local speech-server, or OpenAI's gpt-4o-mini-transcribe",
  memory: {
    unknown: (kind) => "Unknown memory source: " + kind,
    twice: (kind) => "Only one memory source of each kind: " + kind,
    noUrl: "To connect a memory source, fill in its address first",
    url: "A memory source's address is a full address starting with http(s), such as http://127.0.0.1:14242/mcp/ for Nowledge Mem",
    keySpace: "A memory source's key should have no spaces",
  },
  voice: {
    label: {
      silenceMs: "How long a pause ends a turn (ms)",
      interruptMs: "How long you speak to interrupt (ms)",
      idleSeconds: "How long before it leaves an empty call (s)",
    },
    range: (label, min, max) => `${label} must be between ${min} and ${max}`,
    region: "Microsoft recognition needs a region, such as eastasia",
    model: "The model needs a name",
    url: "The model's address is a full address starting with http(s), such as https://api.openai.com/v1/chat/completions",
    voiceId: "The voice cannot be empty: pick one or fill in a MiniMax voice id",
    microsoft: "Microsoft speech needs a region and a voice name",
    persona: "The manager's persona cannot be empty",
  },
  defaults: { language: "en-US", failureMessage: "I got stuck for a moment. Could you say that again?" },
  notSaved: (file, why) => `Could not save ${file}: ${why}`,
};

export const settingWording = localized({ zh, en });
