import { Effect, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { streamMossSpeech } from "@vibevalley/provider/moss/speech-stream";

import { type ApiError, refused } from "#/base/errors.ts";
import { bestEffort } from "#/infra/log.ts";

import { releaseAudioResult, saveAudioStream, type MediaInputs } from "./audioResult.ts";
export interface SpeechStreamSaved {
  attachment?: T.Attachment;
  resultInput: T.MediaInputReference | null;
  metadata: T.MediaAudioMetadata;
  usage?: T.MediaAudioUsage;
  complete: boolean;
}
export interface SpeechStreamPorts {
  inputs: MediaInputs;
  task: (id: string) => Effect.Effect<void, ApiError>;
  emit: (event: T.MediaSpeechEvent) => Effect.Effect<void>;
  save: (result: SpeechStreamSaved) => Effect.Effect<void, ApiError>;
}

export const receiveSpeechStream = Effect.fn("Media.receiveSpeechStream")(function* (
  id: string,
  key: string,
  input: { model: string; text: string; voice: string; format: string },
  ports: SpeechStreamPorts,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let sequence = 0;
  let pending: Uint8Array = new Uint8Array(0);
  let format: { sampleRate: number; channels: number; bitDepth: number } | undefined;
  let usage: T.MediaAudioUsage | undefined;
  let duration: number | undefined;
  let complete = false;
  const save = Effect.gen(function* () {
    if (!format || size === 0) return;
    const actual = format;
    const block = format.channels * 2;
    const length = size - (size % block);
    if (length === 0) return;
    const bytes = Buffer.allocUnsafe(44);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(36 + length, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(format.channels, 22);
    bytes.writeUInt32LE(format.sampleRate, 24);
    bytes.writeUInt32LE(format.sampleRate * block, 28);
    bytes.writeUInt16LE(block, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(length, 40);
    let remaining = length;
    const source = Stream.concat(
      Stream.make(bytes),
      Stream.fromIterable(chunks).pipe(
        Stream.map((chunk) => {
          const part = chunk.subarray(0, remaining);
          remaining -= part.byteLength;
          return part;
        }),
      ),
    );
    yield* Effect.uninterruptibleMask((resume) =>
      Effect.gen(function* () {
        const saved = yield* resume(saveAudioStream(id, "wav", source, ports.inputs, `moss-${id}${complete ? "" : "-partial"}.wav`));
        yield* ports
          .save({
            ...saved,
            metadata: {
              source: complete && duration !== undefined ? "provider" : "file",
              sampleRate: actual.sampleRate,
              channels: actual.channels,
              bitDepth: 16,
              duration: complete && duration !== undefined ? duration : length / (actual.sampleRate * block),
            },
            ...(usage === undefined ? {} : { usage }),
            complete,
          })
          .pipe(Effect.onError(() => releaseAudioResult(id, saved, ports.inputs)));
      }),
    );
  });
  yield* streamMossSpeech(key, input).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "task.created":
            yield* ports.task(event.taskId);
            return;
          case "speech.created":
            if (event.bitDepth !== 16) return yield* Effect.fail(refused(t("server.media.speechInvalid")));
            format = { sampleRate: event.sampleRate, channels: event.channels, bitDepth: event.bitDepth };
            yield* ports.emit({ type: "format", sampleRate: event.sampleRate, channels: event.channels, bitDepth: 16 });
            return;
          case "speech.audio.delta": {
            if (!format || size + event.audio.byteLength > 128 * 1024 * 1024 - 44) return yield* Effect.fail(refused(t("server.media.speechInvalid")));
            const block = format.channels * 2;
            chunks.push(event.audio);
            size += event.audio.byteLength;
            const joined = pending.byteLength === 0 ? event.audio : Buffer.concat([pending, event.audio]);
            const available = joined.byteLength - (joined.byteLength % block);
            pending = joined.slice(available);
            const step = Math.floor(32768 / block) * block;
            for (let offset = 0; offset < available; offset += step) {
              const part = joined.subarray(offset, Math.min(available, offset + step));
              yield* ports.emit({ type: "audio", sequence: sequence++, audio: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64") });
            }
            return;
          }
          case "speech.audio.done":
            if (size === 0 || pending.byteLength !== 0) return yield* Effect.fail(refused(t("server.media.speechInvalid")));
            usage = event.usage;
            duration = event.durationSeconds;
            complete = true;
            return;
        }
      }),
    ),
    Effect.timeout("5 minutes"),
    Effect.tapError(() => save),
    Effect.onInterrupt(() => save.pipe(bestEffort("Partial speech stream could not be saved"))),
  );
  yield* save;
  yield* ports.emit({ type: "done" });
});
