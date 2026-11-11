import { Effect, type FileSystem, Schema, type Scope, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import { attachmentMax } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";

import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { bestEffort } from "#/infra/log.ts";
import { type PublicHttp, publicHttps } from "#/infra/publicHttp.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";

import { audioResultMax, type StagedAudioResult } from "./input.ts";
import { validateSpeechBytes } from "./validateSpeechBytes.ts";

const refused = refuseIn(BizCode.MediaRefused);

export interface AudioSavedResult {
  readonly attachment?: T.Attachment;
  readonly resultInput: T.MediaInputReference | null;
  readonly metadata?: NonNullable<T.MediaSpeechJob["metadata"]>;
}

export interface MediaInputs {
  readonly stageResult: (
    name: string,
    format: T.MediaAudioFormat,
    source: Stream.Stream<Uint8Array, ApiError>,
  ) => Effect.Effect<StagedAudioResult, ApiError, Scope.Scope>;
  readonly storeResult: (staged: StagedAudioResult, holder: string, retainSource?: boolean) => Effect.Effect<T.MediaInputReference, ApiError>;
  readonly release: (holder: string) => Effect.Effect<void, ApiError>;
  readonly delete: (id: string) => Effect.Effect<void, ApiError>;
}

export interface AudioStreamDeps {
  readonly files: Attachment["Service"];
  readonly fs: FileSystem.FileSystem;
}

export interface AudioDownloadDeps extends AudioStreamDeps {
  readonly http: PublicHttp["Service"];
}

const types: Record<T.MediaAudioFormat, readonly string[]> = {
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  mp3: ["audio/mpeg", "audio/mp3"],
  flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac", "audio/aacp"],
  opus: ["audio/opus", "audio/ogg", "application/ogg"],
  pcm: ["audio/pcm", "audio/l16", "application/octet-stream"],
};
const Length = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: audioResultMax }));
const failed = () => refused(t("server.media.speechDownloadFailed"));

export const releaseAudioResult = Effect.fn("Media.releaseAudioResult")(function* (id: string, saved: AudioSavedResult, inputs: MediaInputs) {
  if (!saved.resultInput) return;
  yield* inputs.release(id);
  yield* inputs.delete(saved.resultInput.id);
}, bestEffort("Media audio result rollback is pending"));

export const saveAudioStream = Effect.fn("Media.saveAudioStream")(function* (
  deps: AudioStreamDeps,
  id: string,
  format: T.MediaAudioFormat,
  source: Stream.Stream<Uint8Array, ApiError>,
  inputs: MediaInputs,
  name: string = `moss-${id}.${format}`,
): Effect.fn.Return<AudioSavedResult, ApiError> {
  let retained: AudioSavedResult | undefined;
  return yield* Effect.scoped(
    Effect.uninterruptibleMask((resume) =>
      Effect.gen(function* () {
        const staged = yield* resume(inputs.stageResult(name, format, source));
        const metadata = staged.metadata ? { metadata: staged.metadata } : {};
        if (staged.size > attachmentMax) {
          const resultInput = yield* inputs.storeResult(staged, id);
          retained = { resultInput, ...metadata };
          return retained;
        }
        const bytes = yield* deps.fs.readFile(staged.path).pipe(Effect.mapError(failed));
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (!validateSpeechBytes(buffer, format)) return yield* failed();
        const attachment = yield* deps.files.attach({ name: staged.name, type: staged.mime, data: buffer.toString("base64") });
        return { attachment, resultInput: null, ...metadata };
      }),
    ),
  ).pipe(Effect.onError(() => (retained ? releaseAudioResult(id, retained, inputs) : Effect.void)));
});

export const saveAudioResult = Effect.fn("Media.saveAudioResult")(
  function* (
    deps: AudioDownloadDeps,
    id: string,
    address: string,
    format: T.MediaAudioFormat,
    inputs: MediaInputs,
  ): Effect.fn.Return<AudioSavedResult, ApiError> {
    const url = yield* Schema.decodeEffect(Schema.URLFromString)(address).pipe(Effect.mapError(failed));
    if (!publicHttps(url)) return yield* failed();
    const response = yield* deps.http.get(url, { headers: { accept: types[format].join(", ") } }).pipe(Effect.mapError(failed));
    if (response.status !== 200 || !types[format].includes(response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "")) return yield* failed();
    const declared = response.headers["content-length"];
    const length = declared === undefined ? undefined : yield* Schema.decodeEffect(Length)(declared).pipe(Effect.mapError(failed));
    let size = 0;
    const source = response.stream.pipe(
      Stream.mapError(failed),
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength;
        return size > audioResultMax || (length !== undefined && size > length) ? Effect.fail(failed()) : Effect.succeed(chunk);
      }),
      Stream.concat(
        Stream.fromEffect(Effect.suspend(() => (length !== undefined && size !== length ? Effect.fail(failed()) : Effect.succeed(new Uint8Array(0))))),
      ),
    );
    return yield* saveAudioStream(deps, id, format, source, inputs);
  },
  Effect.timeoutOrElse({
    duration: "300 seconds",
    orElse: () => Effect.fail(failed()),
  }),
);
