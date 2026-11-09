import { Effect, Schema } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";

import { AudioId, audioRequest, MossAudioError } from "./audio-response.ts";

const Submission = Schema.fromJsonString(
  Schema.Struct({
    task_id: AudioId,
    retry_after: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  }),
);

export interface MossAudioSubmission {
  readonly taskId: string;
  readonly retryAfterSeconds?: number;
}

type Endpoint = "speech/speakers" | "voice/generations" | "transcriptions";

export const submitMossAudioTask = Effect.fnUntraced(
  function* (key: string, endpoint: Endpoint, input: unknown) {
    const body = yield* HttpBody.json(input).pipe(Effect.mapError(() => MossAudioError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })));
    const raw = yield* audioRequest(key, HttpClientRequest.post(`https://api.mosi.cn/v1/audio/${endpoint}`, { body }));
    const result = yield* Schema.decodeEffect(Submission)(raw).pipe(
      Effect.mapError(() => MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    return {
      taskId: result.task_id,
      ...(result.retry_after !== undefined ? { retryAfterSeconds: result.retry_after } : {}),
    } satisfies MossAudioSubmission;
  },
  Effect.timeoutOrElse({
    duration: "300 seconds",
    orElse: () => Effect.fail(MossAudioError.make({ reason: "Timeout", outcome: "Unknown" })),
  }),
);
