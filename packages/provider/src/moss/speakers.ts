import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints } from "../base/json.ts";
import { AudioId, invalidAudioInput } from "./audio-response.ts";
import { type MossAudioSubmission, submitMossAudioTask } from "./audio-submission.ts";
import { mossSpeakersModels } from "./speakers-models.ts";
import { mossSpeechFormats } from "./speech-models.ts";

const SpeakerId = codePoints(1, 256).regex(/\S/u);
const Text = codePoints(1, 10000).regex(/\S/u);
const Input = z
  .strictObject({
    model: z.enum(mossSpeakersModels),
    speakers: z
      .array(z.strictObject({ id: SpeakerId, voice: AudioId }))
      .min(1)
      .max(100),
    segments: z
      .array(z.strictObject({ speaker: SpeakerId, text: Text }))
      .min(1)
      .max(1000),
    format: z.enum(mossSpeechFormats),
  })
  .refine((input) => {
    const ids = new Set(input.speakers.map((speaker) => speaker.id));
    if (ids.size !== input.speakers.length) return false;
    let codePoints = 0;
    for (const segment of input.segments) {
      if (!ids.has(segment.speaker)) return false;
      for (const _character of segment.text) {
        codePoints++;
        if (codePoints > 10000) return false;
      }
    }
    return true;
  });

export const prepareMossSpeakers = async (input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw invalidAudioInput();
  const request = parsed.data;
  return {
    model: request.model,
    speakers: request.speakers.map((speaker) => ({ id: speaker.id, voice_id: speaker.voice })),
    segments: request.segments,
    response_format: request.format,
    delivery_method: "url" as const,
    async: true,
  };
};

export const createMossSpeakersTask = async (key: string, input: unknown, http: ProviderHttp): Promise<MossAudioSubmission> =>
  submitMossAudioTask(key, "speech/speakers", await prepareMossSpeakers(input), http);
