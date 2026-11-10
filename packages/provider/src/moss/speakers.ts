import { Effect, Schema } from "effect";

import { AudioId, MossAudioError } from "./audio-response.ts";
import { submitMossAudioTask } from "./audio-submission.ts";
import { mossSpeakersModels } from "./speakers-models.ts";
import { mossSpeechFormats } from "./speech-models.ts";

const SpeakerId = Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/\S/u));
const Text = Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u));
const Input = Schema.Struct({
  model: Schema.Literals(mossSpeakersModels),
  speakers: Schema.Array(Schema.Struct({ id: SpeakerId, voice: AudioId })).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  segments: Schema.Array(Schema.Struct({ speaker: SpeakerId, text: Text })).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  format: Schema.Literals(mossSpeechFormats),
}).check(
  Schema.makeFilter((input) => {
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
  }),
);

export const prepareMossSpeakers = Effect.fn("Provider.prepareMossSpeakers")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MossAudioError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  return {
    model: request.model,
    speakers: request.speakers.map((speaker) => ({ id: speaker.id, voice_id: speaker.voice })),
    segments: request.segments,
    response_format: request.format,
    delivery_method: "url" as const,
    async: true,
  };
});

export const createMossSpeakersTask = Effect.fn("Provider.createMossSpeakersTask")(function* (key: string, input: unknown) {
  const request = yield* prepareMossSpeakers(input);
  return yield* submitMossAudioTask(key, "speech/speakers", request);
});
