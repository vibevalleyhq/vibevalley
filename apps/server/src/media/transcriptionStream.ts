import { Clock, Effect, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { streamMossTranscription } from "@vibevalley/provider/moss/transcription-stream";

import { type ApiError, refused } from "#/base/errors.ts";
import { bestEffort } from "#/infra/log.ts";

export interface TranscriptionCheckpoint {
  result: Extract<T.MediaAudioResult, { kind: "transcription" }>;
  usage?: T.MediaAudioUsage;
  complete: boolean;
}
interface Ports {
  task: (id: string) => Effect.Effect<void, ApiError>;
  save: (value: TranscriptionCheckpoint) => Effect.Effect<void, ApiError>;
}

export const receiveTranscriptionStream = Effect.fn("Media.receiveTranscriptionStream")(function* (
  key: string,
  input: { model: string; fileId: string; diarize?: boolean; keyterms?: readonly string[] },
  ports: Ports,
) {
  let text = "";
  const segments: T.MediaAudioSegment[] = [];
  const indexes = new Set<number>();
  let usage: T.MediaAudioUsage | undefined;
  let dirty = false;
  let complete = false;
  let last = -Infinity;
  const flush = (force: boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (!dirty || (!force && now - last < 200)) return;
      yield* ports.save({ result: { kind: "transcription", text, segments }, ...(usage === undefined ? {} : { usage }), complete });
      last = now;
      dirty = false;
    });
  yield* streamMossTranscription(key, input).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "task.created":
            yield* ports.task(event.taskId);
            return;
          case "transcript.text.delta":
            if (text.length + event.text.length > 1_000_000) return yield* Effect.fail(refused(t("server.media.audioInvalid")));
            text += event.text;
            dirty = true;
            yield* flush(false);
            return;
          case "transcript.segment.done":
            if (segments.length >= 10_000 || indexes.has(event.index)) return yield* Effect.fail(refused(t("server.media.audioInvalid")));
            indexes.add(event.index);
            segments.push(event.segment);
            if (event.usage !== undefined) usage = event.usage;
            dirty = true;
            yield* flush(true);
            return;
          case "transcript.text.done":
            if (event.text.length > 1_000_000) return yield* Effect.fail(refused(t("server.media.audioInvalid")));
            text = event.text;
            if (event.usage !== undefined) usage = event.usage;
            complete = true;
            dirty = true;
            yield* flush(true);
            return;
        }
      }),
    ),
    Effect.onError(() => flush(true).pipe(bestEffort("Partial transcription checkpoint could not be saved"))),
  );
});
