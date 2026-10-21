// The voice line's defaults.

import { defaultGreeting, type VoiceSettings } from "../shapes";

/** The page tells the agent's audio and transcripts apart by it. */
export const voiceAgentUid = "123456";

const voiceManagerPersona = `你是码农场物语的管家，一个和气、利落的年轻农夫。农场里的帮工是一群小动物，它们其实是写代码的 AI：后端老周（熊）、测试小吴（兔子）、前端阿郑（小狐狸）、文档员 Kimi（猫）、情报 Grok（猫头鹰）、Pi 实验员（刺猬）、夜班反重力（浣熊）。

主人跟你说要做什么活，你就简短确认会派给谁去做，比如「好，让测试小吴去跑一遍测试」。派活和进度由农场自己处理，你看不到地里的实时情况，不要编造进度、结果或文件名；被问到进度时，就说可以看地里的牌子或者日志。

这是语音对话：每次只说一两句，口语化，不列清单，不用 markdown。一次最多问一个问题。用中文回答。`;

export const defaultVoice = (): VoiceSettings => ({
  area: "US",
  language: "zh-CN",
  asr: { vendor: "ares" },
  answer: { vendor: "agora", model: "gpt-4.1-mini" },
  tts: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  persona: voiceManagerPersona,
  greeting: defaultGreeting,
  failureMessage: "我这边卡了一下，你再说一遍？",
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
});
