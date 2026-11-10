import { Array as Arr, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { deepseekModels } from "@vibevalley/provider/deepseek/models";
import { mossImageModels } from "@vibevalley/provider/moss/image-models";
import { mossLiveModels } from "@vibevalley/provider/moss/live-models";
import type { MossEvents, MossLink, MossTransport, MossVerify } from "@vibevalley/provider/moss/server";
import { mossSpeakersModels } from "@vibevalley/provider/moss/speakers-models";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";
import { mossTranscriptionModels } from "@vibevalley/provider/moss/transcription-models";
import { mossUnderstandingModels } from "@vibevalley/provider/moss/understanding-models";
import { mossVisionModels } from "@vibevalley/provider/moss/vision-models";
import { mossVoiceDesignModels } from "@vibevalley/provider/moss/voice-design-models";

export interface ImageRequest {
  readonly prompt: unknown;
  readonly width: number;
  readonly height: number;
  readonly seed?: number;
  readonly steps?: number;
  readonly guidance?: number;
  readonly negativePrompt?: string;
  readonly enhance: boolean;
  readonly watermark: boolean;
}

export interface GeneratedImage {
  readonly url: string;
  readonly usage: { readonly images: number; readonly width: number; readonly height: number };
}

export class ImageFailure extends Schema.TaggedError<ImageFailure, { readonly brand: unique symbol }>()("ImageFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest, { readonly brand: unique symbol }>()("InvalidRequest", {}) {}

export interface SpeechRequest {
  readonly text: string;
  readonly voice: string;
  readonly format: T.MediaAudioFormat;
}

export type SpeakersRequest = Pick<T.MediaSpeakersRequest, "speakers" | "segments" | "format">;

export type VoiceDesignRequest = Pick<T.MediaVoiceDesignRequest, "text" | "instruction" | "format">;

export interface TranscriptionRequest {
  readonly fileId: string;
  readonly diarize?: boolean;
  readonly keyterms?: readonly string[];
}

export interface CloneRequest {
  readonly audio: Blob;
  readonly filename: string;
  /** Inspected from the audio file, never asserted by client or model. */
  readonly durationSeconds: number;
  readonly name?: string;
}

export type TranscriptionEvent =
  | { readonly type: "task.created"; readonly taskId: string }
  | { readonly type: "transcript.text.delta"; readonly text: string }
  | { readonly type: "transcript.segment.done"; readonly index: number; readonly segment: T.MediaAudioSegment; readonly usage?: T.MediaAudioUsage }
  | { readonly type: "transcript.text.done"; readonly text: string; readonly usage?: T.MediaAudioUsage };

export interface UnderstandingRequest {
  readonly text: string;
  readonly media: readonly { readonly kind: T.MediaInputReference["kind"]; readonly fileId: string }[];
  readonly maxOutputTokens: number;
}

export class UnderstandingFailure extends Schema.TaggedError<UnderstandingFailure, { readonly brand: unique symbol }>()("UnderstandingFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
}) {}

export interface FileUpload {
  readonly file: Blob;
  readonly filename: string;
  readonly purpose: "image" | "video" | "audio";
}

export interface UploadedFile {
  readonly id: string;
  readonly state: "ready" | "rejected" | "unknown";
}

export class FileFailure extends Schema.TaggedError<FileFailure, { readonly brand: unique symbol }>()("FileFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
}) {}

export interface GeneratedAudio {
  readonly url: string;
  readonly format: T.MediaAudioFormat;
  readonly contentType: string;
  readonly usage?: T.MediaAudioUsage;
}

export type AudioTask =
  | { readonly kind: "speech" | "voiceGeneration" | "transcription"; readonly status: "waiting" | "failed" }
  | ({ readonly kind: "speech" | "voiceGeneration"; readonly status: "ready" } & GeneratedAudio)
  | {
      readonly kind: "transcription";
      readonly status: "ready";
      readonly text: string;
      readonly segments?: readonly T.MediaAudioSegment[];
      readonly usage?: T.MediaAudioUsage;
    };

export type SpeechEvent =
  | { readonly type: "task.created"; readonly taskId: string }
  | { readonly type: "speech.created"; readonly sampleRate: number; readonly channels: number; readonly bitDepth: number }
  | { readonly type: "speech.audio.delta"; readonly audio: Uint8Array }
  | { readonly type: "speech.audio.done"; readonly usage?: T.MediaAudioUsage; readonly durationSeconds?: number };

export class AudioFailure extends Schema.TaggedError<AudioFailure, { readonly brand: unique symbol }>()("AudioFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
  /** True for network, timeout, 429 and 5xx responses. */
  retryable: Schema.Boolean,
}) {}

export type RealtimeLink = MossLink;
export type RealtimeEvents = MossEvents;
export type RealtimeTransport = MossTransport;
export type RealtimeCheck = MossVerify;

export interface Vendor {
  readonly name: string;
  readonly console: string;
  readonly keys: "account" | "setting";
  readonly image?: { readonly models: readonly string[] };
  readonly speech?: { readonly models: readonly string[] };
  readonly speakers?: { readonly models: readonly string[] };
  readonly voiceDesign?: { readonly models: readonly string[] };
  readonly transcription?: { readonly models: readonly string[] };
  readonly understanding?: { readonly models: readonly string[] };
  readonly live?: { readonly models: readonly string[] };
  readonly vision?: { readonly models: readonly string[] };
  readonly chat?: { readonly models: readonly string[] };
  readonly call?: { readonly line: "rtc" };
}

export const vendors: Record<"moss" | "deepseek" | "agora", Vendor> = {
  moss: {
    name: "MOSS",
    console: "https://platform.moss.cn/",
    keys: "account",
    image: { models: mossImageModels },
    speech: { models: mossSpeechModels },
    speakers: { models: mossSpeakersModels },
    voiceDesign: { models: mossVoiceDesignModels },
    transcription: { models: mossTranscriptionModels },
    understanding: { models: mossUnderstandingModels },
    live: { models: mossLiveModels },
    vision: { models: mossVisionModels },
  },
  deepseek: {
    name: "DeepSeek",
    console: "https://platform.deepseek.com/api_keys",
    keys: "setting",
    chat: { models: Arr.map(deepseekModels, (model) => model.id) },
  },
  agora: { name: "Agora", console: "https://console.agora.io/", keys: "setting", call: { line: "rtc" } },
};
