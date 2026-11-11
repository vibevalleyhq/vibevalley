import { Agent, type AgoraClient, AresSTT, DeepgramSTT, MicrosoftSTT, MicrosoftTTS, MiniMaxTTS, OpenAI, OpenAITTS } from "agora-agents";
import { Schema } from "effect";

import type { VoiceSettings } from "@vibevalley/protocol";
import { ApiError, BizCode, type VoiceFix } from "@vibevalley/protocol/api";

export const voiceAgentUid = "123456";
const deepseekChat = "https://api.deepseek.com/chat/completions";
const defaultOrchestratorModel = "vibevalley-orchestrator";

export interface VoiceKeys {
  readonly asrKey: string;
  readonly llmKey: string;
  readonly ttsKey: string;
}

export interface CallLine {
  readonly id: string;
  readonly url: string;
  readonly key: string;
}

export interface VendorMessages {
  readonly noAsrKey: () => string;
  readonly noLine: () => string;
  readonly noDeepseekKey: () => string;
  readonly noLlmKey: () => string;
  readonly noTtsKey: () => string;
  readonly unknownAsr: (vendor: string) => string;
  readonly unknownLlm: (vendor: string) => string;
  readonly unknownTts: (vendor: string) => string;
  readonly unusable: (why: string) => string;
}

/** settings: the Settings section the user fixes it in, when a setting does; the page offers to go there. */
export const unavailable = (reason: string, settings?: VoiceFix): ApiError =>
  ApiError.make({
    bizCode: BizCode.VoiceUnavailable,
    message: reason,
    ...(settings ? { settings } : {}),
  });

const errorMessage = (u: unknown): string => (u instanceof Error ? u.message : String(u));

/** A step of a call outside the farm (Agora, the orchestrator's answer) that did not go; cause is what it threw. */
export class CallStepFailed extends Schema.TaggedError<CallStepFailed, { readonly brand: unique symbol }>()("CallStepFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const callStepFailed = (cause: unknown) => CallStepFailed.make({ message: errorMessage(cause), cause });

export const failed = (reason: string): ApiError => ApiError.make({ bizCode: BizCode.VoiceCallFailed, message: reason });

export type Vendors = {
  stt: AresSTT | DeepgramSTT | MicrosoftSTT;
  llm: OpenAI;
  tts: MiniMaxTTS | OpenAITTS | MicrosoftTTS;
};

const UnknownVendor = Schema.Struct({ vendor: Schema.optionalKey(Schema.String) });
const unknownVendorOf = (v: unknown) => {
  const decoded = Schema.decodeUnknownOption(UnknownVendor)(v);
  return decoded._tag === "Some" ? (decoded.value.vendor ?? "") : "";
};

/** The three vendors the voice page chose, or why they cannot be: a vendor whose key is missing. Agora-hosted ones need no key of their own. */
export function buildVendors(
  voice: VoiceSettings,
  keys: VoiceKeys,
  deepseekKey: string,
  messages: VendorMessages,
  line?: CallLine,
  orchestratorModel = defaultOrchestratorModel,
): Vendors | ApiError {
  const speech = {
    greetingMessage: voice.greeting,
    failureMessage: voice.failureMessage,
    maxHistory: 15,
    params: { max_tokens: 512, temperature: 0.7, top_p: 0.95 },
    ...(voice.persona ? { systemMessages: [{ role: "system", content: voice.persona }] } : {}),
  };
  try {
    let stt: Vendors["stt"];
    const asr = voice.asr;
    switch (asr.vendor) {
      case "ares":
        stt = new AresSTT();
        break;
      case "deepgram":
        stt = new DeepgramSTT({ model: asr.model, language: voice.language });
        break;
      case "microsoft":
        if (!keys.asrKey) return unavailable(messages.noAsrKey(), "call");
        stt = new MicrosoftSTT({ key: keys.asrKey, region: asr.region, language: voice.language });
        break;
      default: {
        const exhaustive: never = asr;
        return unavailable(messages.unknownAsr(unknownVendorOf(exhaustive)));
      }
    }
    let llm: OpenAI;
    const answer = voice.answer;
    switch (answer.vendor) {
      case "orchestrator":
      case "moss":
        if (!line) return unavailable(messages.noLine());
        llm = new OpenAI({ apiKey: line.key, url: line.url, model: orchestratorModel, ...speech });
        break;
      case "agora":
        llm = new OpenAI({ model: answer.model, ...speech });
        break;
      case "deepseek":
        if (!deepseekKey) return unavailable(messages.noDeepseekKey(), "models");
        llm = new OpenAI({
          apiKey: deepseekKey,
          url: deepseekChat,
          model: answer.model,
          ...speech,
        });
        break;
      case "openai":
        if (!keys.llmKey) return unavailable(messages.noLlmKey(), "call");
        llm = new OpenAI({ apiKey: keys.llmKey, url: answer.url, model: answer.model, ...speech });
        break;
      default: {
        const exhaustive: never = answer;
        return unavailable(messages.unknownLlm(unknownVendorOf(exhaustive)));
      }
    }
    let tts: Vendors["tts"];
    const item = voice.tts;
    switch (item.vendor) {
      case "minimax":
        tts = new MiniMaxTTS({ model: item.model, voiceId: item.voiceId });
        break;
      case "openai":
        tts = new OpenAITTS({ voice: item.voice });
        break;
      case "microsoft":
        if (!keys.ttsKey) return unavailable(messages.noTtsKey(), "call");
        tts = new MicrosoftTTS({ key: keys.ttsKey, region: item.region, voiceName: item.voiceName });
        break;
      default: {
        const exhaustive: never = item;
        return unavailable(messages.unknownTts(unknownVendorOf(exhaustive)));
      }
    }
    return { stt, llm, tts };
  } catch (e) {
    return unavailable(messages.unusable(errorMessage(e)), "call");
  }
}

/** Read at each start: a change takes effect on the next call. Captions go over the RTC data stream: the client has no RTM. */
export function agentFor(client: AgoraClient, voice: VoiceSettings, vendors: Vendors) {
  return new Agent({
    client,
    turnDetection: {
      language: voice.language,
      config: {
        speech_threshold: 0.5,
        start_of_speech: {
          mode: "vad",
          vad_config: { interrupt_duration_ms: voice.interruptMs, prefix_padding_ms: 300 },
        },
        end_of_speech: { mode: "vad", vad_config: { silence_duration_ms: voice.silenceMs } },
      },
    },
    advancedFeatures: { enable_rtm: false, enable_tools: true },
    parameters: {
      audio_scenario: "chorus",
      data_channel: "datastream",
      enable_error_message: true,
      enable_metrics: true,
    },
  })
    .withStt(vendors.stt)
    .withLlm(vendors.llm)
    .withTts(vendors.tts);
}

/** Agora reads out at most 512 bytes at a time: the words in pieces under that, cut after a sentence where one ends. */
export function speakPieces(text: string, max = 480): string[] {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  const out: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    if (bytes(rest) <= max) {
      out.push(rest);
      break;
    }
    const chars = [...rest];
    let fit = 0;
    let used = 0;
    for (const ch of chars) {
      const len = bytes(ch);
      if (used + len > max) break;
      used += len;
      fit++;
    }
    const head = chars.slice(0, fit).join("");
    const end = Math.max(-1, ...[...head.matchAll(/[。！？!?；;\n]/gu)].map((m) => m.index));
    const cut = end > 0 ? [...head.slice(0, end + 1)].length : fit;
    out.push(chars.slice(0, cut).join("").trim());
    rest = chars.slice(cut).join("").trim();
  }
  return out.filter(Boolean);
}
