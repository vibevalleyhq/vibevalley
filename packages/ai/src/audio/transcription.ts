import { transcribe, type TranscriptionEndEvent, type TranscriptionModel } from "ai";
import { Effect, Schema } from "effect";

import { TranscriptionFormat } from "@vibevalley/provider/transcription";

export type AudioFailure =
  | { readonly _tag: "UnsupportedFormat"; readonly format: string }
  | { readonly _tag: "EmptyAudio" }
  | { readonly _tag: "AudioTooLong" };

export class TranscriptionFailed extends Schema.TaggedError<TranscriptionFailed, { readonly brand: unique symbol }>()("TranscriptionFailed", {
  cause: Schema.Defect(),
}) {}

export const transcriptionAudio = Effect.fn("AI.transcriptionAudio")(function* (audio64: string, given: string) {
  const format = given.trim().replace(/^\./u, "").toLowerCase();
  const decoded = Schema.decodeUnknownOption(TranscriptionFormat)(format);
  if (decoded._tag === "None") return yield* Effect.fail<AudioFailure>({ _tag: "UnsupportedFormat", format });
  const audio = Buffer.from(audio64, "base64");
  if (audio.length === 0 || audio.toString("base64").replace(/=+$/u, "") !== audio64.replace(/=+$/u, "").replace(/\s/gu, ""))
    return yield* Effect.fail<AudioFailure>({ _tag: "EmptyAudio" });
  if (audio.length > 25 << 20) return yield* Effect.fail<AudioFailure>({ _tag: "AudioTooLong" });
  return { audio, format: decoded.value };
});

export const transcribeAudio = Effect.fn("AI.transcribeAudio")(function* (model: Exclude<TranscriptionModel, string>, audio: Uint8Array) {
  // Core 7.0.164 emits usage in onEnd but omits it from TranscriptionResult.
  let usage: TranscriptionEndEvent["usage"];
  const result = yield* Effect.tryPromise({
    try: (abortSignal) =>
      transcribe({
        model,
        audio,
        abortSignal,
        maxRetries: 0,
        telemetry: {
          recordInputs: false,
          recordOutputs: false,
          integrations: [
            {
              onEnd: (event: TranscriptionEndEvent) => {
                usage = event.usage;
              },
            },
          ],
        },
      }),
    catch: (cause) => TranscriptionFailed.make({ cause }),
  });
  return { ...result, usage };
});
