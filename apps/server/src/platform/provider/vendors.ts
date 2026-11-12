import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

import type * as T from "@vibevalley/protocol";
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

/** Whether the vendor may have taken (and billed) the call: Rejected says it did not. */
export type VendorFailureOutcome = "Rejected" | "Unknown";

export class ImageFailure extends Error {
  override readonly name = "ImageFailure";
  readonly outcome: VendorFailureOutcome;
  constructor(fields: { readonly outcome: VendorFailureOutcome }) {
    super(`image: ${fields.outcome}`);
    this.outcome = fields.outcome;
  }
}

export class InvalidRequest extends Error {
  override readonly name = "InvalidRequest";
  constructor() {
    super("The vendor would not take this request");
  }
}

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

export class UnderstandingFailure extends Error {
  override readonly name = "UnderstandingFailure";
  readonly outcome: VendorFailureOutcome;
  constructor(fields: { readonly outcome: VendorFailureOutcome }) {
    super(`understanding: ${fields.outcome}`);
    this.outcome = fields.outcome;
  }
}

export interface FileUpload {
  readonly file: Blob;
  readonly filename: string;
  readonly purpose: "image" | "video" | "audio";
}

export interface UploadedFile {
  readonly id: string;
  readonly state: "ready" | "rejected" | "unknown";
}

export class FileFailure extends Error {
  override readonly name = "FileFailure";
  readonly outcome: VendorFailureOutcome;
  constructor(fields: { readonly outcome: VendorFailureOutcome }) {
    super(`file: ${fields.outcome}`);
    this.outcome = fields.outcome;
  }
}

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

export class AudioFailure extends Error {
  override readonly name = "AudioFailure";
  readonly outcome: VendorFailureOutcome;
  /** True for network, timeout, 429 and 5xx responses. */
  readonly retryable: boolean;
  constructor(fields: { readonly outcome: VendorFailureOutcome; readonly retryable: boolean }) {
    super(`audio: ${fields.outcome}`);
    this.outcome = fields.outcome;
    this.retryable = fields.retryable;
  }
}

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
    chat: {
      models: deepseekProvider()
        .getModels()
        .map((model) => model.id),
    },
  },
  agora: { name: "Agora", console: "https://console.agora.io/", keys: "setting", call: { line: "rtc" } },
};
