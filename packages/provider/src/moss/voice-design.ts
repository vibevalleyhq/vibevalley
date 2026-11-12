import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints } from "../base/json.ts";
import { invalidAudioInput } from "./audio-response.ts";
import { type MossAudioSubmission, submitMossAudioTask } from "./audio-submission.ts";
import { mossSpeechFormats } from "./speech-models.ts";
import { mossVoiceDesignModels } from "./voice-design-models.ts";

const Text = codePoints(1, 10000).regex(/\S/u);
const Input = z.strictObject({
  model: z.enum(mossVoiceDesignModels),
  text: Text,
  instruction: Text,
  format: z.enum(mossSpeechFormats),
});

export const prepareMossVoiceDesign = async (input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw invalidAudioInput();
  const request = parsed.data;
  return {
    model: request.model,
    input: request.text,
    instruction: request.instruction,
    response_format: request.format,
    delivery_method: "url" as const,
    // The task-query contract does not document a voice_id; never silently create an untrackable voice.
    create_voice: false,
    async: true,
  };
};

export const createMossVoiceDesignTask = async (key: string, input: unknown, http: ProviderHttp): Promise<MossAudioSubmission> =>
  submitMossAudioTask(key, "voice/generations", await prepareMossVoiceDesign(input), http);
