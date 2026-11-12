import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints, fromJson, int } from "../base/json.ts";
import {
  AudioId,
  audioJson,
  audioMimeMatches,
  audioRequest,
  audioResultShape,
  AudioUsage,
  audioUsage,
  boundedAudio,
  invalidAudioInput,
  invalidAudioResponse,
  type MossAudioUsage,
} from "./audio-response.ts";
import { mossSpeechFormats, mossSpeechLanguages, mossSpeechModels } from "./speech-models.ts";

const Text = codePoints(1, 10000).regex(/\S/u);
const Metadata = z.strictObject({
  enabled: z.boolean(),
  contentPropagator: z.exactOptional(codePoints(1, 128)),
  propagateId: z.exactOptional(codePoints(1, 256)),
});
const Input = z
  .strictObject({
    model: z.enum(mossSpeechModels),
    text: Text,
    voice: AudioId,
    format: z.enum(mossSpeechFormats),
    language: z.exactOptional(z.enum(mossSpeechLanguages)),
    expectedDuration: z.exactOptional(z.number().gt(0).max(3600)),
    metadata: z.exactOptional(Metadata),
  })
  .refine((input) => {
    if (input.model === "moss-tts-1.0-pro" || input.model === "moss-tts-1.0-pro-2026-02-07")
      return input.language === undefined && !input.text.includes("[pause");
    return [...input.text.matchAll(/\[pause[^\]]*\]/gu)].every(([pause]) => /^\[pause (?:0\.[1-9]\d*|[1-9](?:\.\d+)?|10(?:\.0+)?)s\]$/u.test(pause));
  });
const SpeechResponse = z
  .object({
    id: AudioId,
    object: z.literal("audio.speech"),
    status: z.literal("SUCCESS"),
    created_at: int(),
    ...audioResultShape,
    usage: z.exactOptional(AudioUsage),
  })
  .refine(audioMimeMatches);
const Submission = z.object({ task_id: AudioId });

export interface MossSpeechRequest {
  readonly model: (typeof mossSpeechModels)[number];
  readonly input: string;
  readonly voice_id: string;
  readonly response_format: (typeof mossSpeechFormats)[number];
  readonly delivery_method: "url";
  readonly stream: false;
  readonly language?: (typeof mossSpeechLanguages)[number];
  readonly expected_duration_sec?: number;
  readonly aigc_metadata?: { readonly enabled: boolean; readonly content_propagator?: string; readonly propagate_id?: string };
}

/** The wire request for input, or InvalidInput (nothing sent) when input is not a speech request MOSS takes. */
export const prepareMossSpeech = async (input: unknown): Promise<MossSpeechRequest> => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw invalidAudioInput();
  const request = parsed.data;
  return {
    model: request.model,
    input: request.text,
    voice_id: request.voice,
    response_format: request.format,
    delivery_method: "url" as const,
    stream: false,
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.expectedDuration !== undefined ? { expected_duration_sec: request.expectedDuration } : {}),
    ...(request.metadata !== undefined
      ? {
          aigc_metadata: {
            enabled: request.metadata.enabled,
            ...(request.metadata.contentPropagator !== undefined ? { content_propagator: request.metadata.contentPropagator } : {}),
            ...(request.metadata.propagateId !== undefined ? { propagate_id: request.metadata.propagateId } : {}),
          },
        }
      : {}),
  };
};

const post = async (key: string, input: unknown, asynchronous: boolean, http: ProviderHttp, signal: AbortSignal) => {
  const request = await prepareMossSpeech(input);
  const body = audioJson({ ...request, async: asynchronous });
  return audioRequest(key, { method: "POST", url: "https://api.mosi.cn/v1/audio/speech", body }, http, signal);
};

export interface MossSpeech {
  readonly id: string;
  readonly url: string;
  readonly format: (typeof mossSpeechFormats)[number];
  readonly contentType: string;
  readonly createdAt: number;
  readonly usage?: MossAudioUsage;
}

export const generateMossSpeech = (key: string, input: unknown, http: ProviderHttp): Promise<MossSpeech> =>
  boundedAudio(300_000, http, async (signal) => {
    const result = fromJson(SpeechResponse, await post(key, input, false, http, signal));
    if (result === undefined) throw invalidAudioResponse();
    return {
      id: result.id,
      url: result.url.href,
      format: result.response_format,
      contentType: result.content_type,
      createdAt: result.created_at,
      ...(result.usage !== undefined ? { usage: audioUsage(result.usage) } : {}),
    };
  });

export const createMossSpeechTask = (key: string, input: unknown, http: ProviderHttp): Promise<{ readonly taskId: string }> =>
  boundedAudio(300_000, http, async (signal) => {
    const result = fromJson(Submission, await post(key, input, true, http, signal));
    if (result === undefined) throw invalidAudioResponse();
    return { taskId: result.task_id };
  });
