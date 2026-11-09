import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { mossImageModels } from "@vibevalley/provider/moss/image-models";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";

/** What an image is asked for with, whoever draws it. A layout prompt is the parsed layout. */
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

/** A drawn image: where to fetch it (signed, short-lived), and what the vendor says it made. */
export interface GeneratedImage {
  readonly url: string;
  readonly usage: { readonly images: number; readonly width: number; readonly height: number };
}

/** An image call that gave no image: refused by the vendor, or with no answer to say whether it ran (and was paid for). */
export class ImageFailure extends Schema.TaggedError<ImageFailure, { readonly brand: unique symbol }>()("ImageFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
}) {}

/** A request the bound model does not take: nothing was sent. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest, { readonly brand: unique symbol }>()("InvalidRequest", {}) {}

/** What speech is asked for, whoever speaks it; the model is the account's. */
export interface SpeechRequest {
  readonly text: string;
  readonly voice: string;
  readonly format: T.MediaAudioFormat;
}

/** Made audio: where to fetch it (signed, short-lived), in which format, and what the vendor says it used. */
export interface GeneratedAudio {
  readonly url: string;
  readonly format: T.MediaAudioFormat;
  readonly contentType: string;
  readonly usage?: T.MediaAudioUsage;
}

/** An audio task the vendor runs, as asked again: still going, failed, or made (audio or a transcript). */
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

/** One step of streamed speech: the vendor's task, the audio's format, a piece of it, and the end with what it used. */
export type SpeechEvent =
  | { readonly type: "task.created"; readonly taskId: string }
  | { readonly type: "speech.created"; readonly sampleRate: number; readonly channels: number; readonly bitDepth: number }
  | { readonly type: "speech.audio.delta"; readonly audio: Uint8Array }
  | { readonly type: "speech.audio.done"; readonly usage?: T.MediaAudioUsage; readonly durationSeconds?: number };

/** An audio call that gave no answer: refused by the vendor, or with no answer to say whether it ran; `retryable` when
 * asking again may get one (the network, a timeout, the vendor busy or failing). */
export class AudioFailure extends Schema.TaggedError<AudioFailure, { readonly brand: unique symbol }>()("AudioFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
  retryable: Schema.Boolean,
}) {}

/** A vendor an account is of: its name, where its keys are made, and the models it has for each thing it serves. */
export interface Vendor {
  readonly name: string;
  readonly console: string;
  readonly image?: { readonly models: readonly string[] };
  readonly speech?: { readonly models: readonly string[] };
}

/** Every vendor, by the adapter an account names. How each one is called is the Provider's business (provider.ts). */
export const vendors: Record<"moss", Vendor> = {
  moss: { name: "MOSS", console: "https://platform.moss.cn/", image: { models: mossImageModels }, speech: { models: mossSpeechModels } },
};
