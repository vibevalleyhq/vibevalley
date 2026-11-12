import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints, fromJson, int } from "../base/json.ts";
import {
  AudioId,
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
import { type mossSpeechFormats } from "./speech-models.ts";

export interface MossTranscriptionSegment {
  readonly speaker: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface TaskBase {
  readonly id: string;
  readonly createdAtSeconds: number;
  readonly updatedAtSeconds: number;
}

export type MossAudioTask = TaskBase &
  (
    | { readonly object: "audio.speech" | "audio.voice_generation" | "audio.transcription"; readonly status: "PENDING" | "PROCESSING" | "FAILED" }
    | {
        readonly object: "audio.speech" | "audio.voice_generation";
        readonly status: "SUCCESS";
        readonly url: string;
        readonly format: (typeof mossSpeechFormats)[number];
        readonly contentType: string;
        readonly usage?: MossAudioUsage;
      }
    | {
        readonly object: "audio.transcription";
        readonly status: "SUCCESS";
        readonly text: string;
        readonly segments?: readonly MossTranscriptionSegment[];
        readonly usage?: MossAudioUsage;
      }
  );

const Time = int();
const Base = { id: AudioId, created_at: Time, updated_at: Time };
const ObjectType = z.enum(["audio.speech", "audio.voice_generation", "audio.transcription"]);
const Waiting = z.object({ ...Base, object: ObjectType, status: z.enum(["PENDING", "PROCESSING"]) });
const Failed = z.object({ ...Base, object: ObjectType, status: z.literal("FAILED") });
const Audio = z
  .object({
    ...Base,
    object: z.enum(["audio.speech", "audio.voice_generation"]),
    status: z.literal("SUCCESS"),
    ...audioResultShape,
    usage: z.exactOptional(AudioUsage),
  })
  .refine(audioMimeMatches);
const Segment = z
  .object({
    speaker: codePoints(1, 256),
    text: z.string(),
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine((segment) => segment.end >= segment.start);
const Transcription = z.object({
  ...Base,
  object: z.literal("audio.transcription"),
  status: z.literal("SUCCESS"),
  text: z.string(),
  segments: z.exactOptional(z.array(Segment).max(10000)),
  usage: z.exactOptional(AudioUsage),
});
const Task = z.union([Waiting, Failed, Audio, Transcription]).refine((task) => task.updated_at >= task.created_at);

export const getMossAudioTask = (key: string, id: string, http: ProviderHttp): Promise<MossAudioTask> =>
  boundedAudio(30_000, http, async (signal): Promise<MossAudioTask> => {
    const checked = AudioId.safeParse(id);
    if (!checked.success) throw invalidAudioInput();
    const raw = await audioRequest(key, { method: "GET", url: `https://api.mosi.cn/v1/audio/tasks/${checked.data}` }, http, signal);
    const task = fromJson(Task, raw);
    if (task === undefined || task.id !== checked.data) throw invalidAudioResponse();
    const base = { id: task.id, createdAtSeconds: task.created_at, updatedAtSeconds: task.updated_at };
    switch (task.status) {
      case "PENDING":
      case "PROCESSING":
      case "FAILED":
        return { ...base, object: task.object, status: task.status };
      case "SUCCESS":
        switch (task.object) {
          case "audio.speech":
          case "audio.voice_generation":
            return {
              ...base,
              object: task.object,
              status: task.status,
              url: task.url.href,
              format: task.response_format,
              contentType: task.content_type,
              ...(task.usage !== undefined ? { usage: audioUsage(task.usage) } : {}),
            };
          case "audio.transcription":
            return {
              ...base,
              object: task.object,
              status: task.status,
              text: task.text,
              ...(task.segments !== undefined ? { segments: task.segments } : {}),
              ...(task.usage !== undefined ? { usage: audioUsage(task.usage) } : {}),
            };
        }
    }
  });
