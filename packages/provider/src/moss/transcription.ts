import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints } from "../base/json.ts";
import { AudioId, invalidAudioInput } from "./audio-response.ts";
import { type MossAudioSubmission, submitMossAudioTask } from "./audio-submission.ts";
import { mossTranscriptionModels } from "./transcription-models.ts";

const Input = z
  .strictObject({
    model: z.enum(mossTranscriptionModels),
    fileId: AudioId,
    diarize: z.exactOptional(z.boolean()),
    keyterms: z.exactOptional(z.array(codePoints(1, 30).regex(/\S/u)).max(20)),
  })
  .refine(
    (input) =>
      input.model === "moss-transcribe-diarize-pro" ||
      input.model === "moss-transcribe-diarize-pro-2026-07-03" ||
      (input.diarize !== true && (input.keyterms === undefined || input.keyterms.length === 0)),
  );

export const prepareMossTranscription = async (input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw invalidAudioInput();
  const request = parsed.data;
  return {
    model: request.model,
    file_id: request.fileId,
    response_format: "json" as const,
    async: true,
    stream: false,
    ...(request.diarize !== undefined ? { diarize: request.diarize } : {}),
    ...(request.keyterms !== undefined ? { keyterms: request.keyterms } : {}),
  };
};

export const createMossTranscriptionTask = async (key: string, input: unknown, http: ProviderHttp): Promise<MossAudioSubmission> =>
  submitMossAudioTask(key, "transcriptions", await prepareMossTranscription(input), http);
