import { Effect, Schema } from "effect";

import { AudioId, MossAudioError } from "./audio-response.ts";
import { submitMossAudioTask } from "./audio-submission.ts";
import { mossTranscriptionModels } from "./transcription-models.ts";

const Input = Schema.Struct({
  model: Schema.Literals(mossTranscriptionModels),
  fileId: AudioId,
  diarize: Schema.optionalKey(Schema.Boolean),
  keyterms: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isBetweenCodePoints(1, 30), Schema.isPattern(/\S/u))).check(Schema.isMaxLength(20))),
}).check(
  Schema.makeFilter(
    (input) =>
      input.model === "moss-transcribe-diarize-pro" ||
      input.model === "moss-transcribe-diarize-pro-2026-07-03" ||
      (input.diarize !== true && (input.keyterms === undefined || input.keyterms.length === 0)),
  ),
);

export const prepareMossTranscription = Effect.fn("Provider.prepareMossTranscription")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  return {
    model: request.model,
    file_id: request.fileId,
    response_format: "json" as const,
    async: true,
    stream: false,
    ...(request.diarize !== undefined ? { diarize: request.diarize } : {}),
    ...(request.keyterms !== undefined ? { keyterms: request.keyterms } : {}),
  };
});

export const createMossTranscriptionTask = Effect.fn("Provider.createMossTranscriptionTask")(function* (key: string, input: unknown) {
  const request = yield* prepareMossTranscription(input);
  return yield* submitMossAudioTask(key, "transcriptions", request);
});
