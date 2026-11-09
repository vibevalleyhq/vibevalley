import { Effect, Schema } from "effect";

import { MossAudioError } from "./audio-response.ts";
import { submitMossAudioTask } from "./audio-submission.ts";
import { mossSpeechFormats } from "./speech-models.ts";
import { mossVoiceDesignModels } from "./voice-design-models.ts";

const Text = Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u));
const Input = Schema.Struct({
  model: Schema.Literals(mossVoiceDesignModels),
  text: Text,
  instruction: Text,
  format: Schema.Literals(mossSpeechFormats),
});

export const prepareMossVoiceDesign = Effect.fn("Provider.prepareMossVoiceDesign")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
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
});

export const createMossVoiceDesignTask = Effect.fn("Provider.createMossVoiceDesignTask")(function* (key: string, input: unknown) {
  const request = yield* prepareMossVoiceDesign(input);
  return yield* submitMossAudioTask(key, "voice/generations", request);
});
