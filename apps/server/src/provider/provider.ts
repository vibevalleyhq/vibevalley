import { createHash } from "node:crypto";

import { Context, Effect, Layer, type Scope, Stream, String as Str } from "effect";
import { HttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import type { Refused } from "@vibevalley/protocol/api";
import { getMossAudioTask, type MossAudioTask } from "@vibevalley/provider/moss/audio-tasks";
import { deleteMossFile, uploadMossFile } from "@vibevalley/provider/moss/files";
import { generateMossImage, prepareMossImage } from "@vibevalley/provider/moss/image";
import { type MossModelError, mossModels } from "@vibevalley/provider/moss/models";
import { nodeMossTransport, verifyMoss } from "@vibevalley/provider/moss/server";
import { createMossSpeakersTask, prepareMossSpeakers } from "@vibevalley/provider/moss/speakers";
import { createMossSpeechTask, generateMossSpeech, prepareMossSpeech } from "@vibevalley/provider/moss/speech";
import { streamMossSpeech } from "@vibevalley/provider/moss/speech-stream";
import { createMossTranscriptionTask, prepareMossTranscription } from "@vibevalley/provider/moss/transcription";
import { streamMossTranscription } from "@vibevalley/provider/moss/transcription-stream";
import { prepareMossUnderstanding, understandMossMedia } from "@vibevalley/provider/moss/understanding";
import { createMossVoiceDesignTask, prepareMossVoiceDesign } from "@vibevalley/provider/moss/voice-design";
import { createMossVoice, listMossVoices } from "@vibevalley/provider/moss/voices";
import { mossTranscription, type TranscriptionFormat, transcriptionModel } from "@vibevalley/provider/transcription";

import { bindingOf, boundConnection, type ProviderSettings } from "#/setting/provider.ts";
import { Setting } from "#/setting/setting.ts";

import { connectionsOver, providerStatus } from "./connections.ts";
import {
  AudioFailure,
  type AudioTask,
  type CloneRequest,
  FileFailure,
  type FileUpload,
  type GeneratedAudio,
  type GeneratedImage,
  ImageFailure,
  type ImageRequest,
  InvalidRequest,
  type RealtimeCheck,
  type RealtimeEvents,
  type RealtimeLink,
  type RealtimeTransport,
  type SpeakersRequest,
  type SpeechEvent,
  type SpeechRequest,
  type TranscriptionEvent,
  type TranscriptionRequest,
  type UnderstandingRequest,
  UnderstandingFailure,
  type UploadedFile,
  vendors,
  type VoiceDesignRequest,
} from "./vendors.ts";

/** An account bound to draw, as it was when a task was asked for, and the call that draws. */
export interface BoundImage {
  readonly connection: string;
  readonly revision: number;
  readonly model: string;
  readonly run: Effect.Effect<GeneratedImage, ImageFailure>;
}

/** How a vendor draws: a request checked against one of its models, as the call to make later with the key. */
type ImageCall = (
  model: string,
  request: ImageRequest,
) => Effect.Effect<(key: string) => Effect.Effect<GeneratedImage, ImageFailure, HttpClient.HttpClient>, "invalid">;

/** MOSS draws: its own answer read as an image, and its own failures as whether one can have been made. */
const mossDraw = Effect.fnUntraced(
  function* (key: string, prepared: unknown) {
    const result = yield* generateMossImage(key, prepared);
    return { url: result.url, usage: { images: result.usage.generated_images, width: result.usage.output_width, height: result.usage.output_height } };
  },
  // Not sent is refused too: nothing was asked of the vendor, so nothing can have been made or paid for.
  Effect.catchTag("MossImageError", (error) => Effect.fail(ImageFailure.make({ outcome: error.outcome === "Unknown" ? "Unknown" : "Rejected" }))),
);

const mossImage: ImageCall = Effect.fnUntraced(function* (model, request) {
  const prepared = yield* prepareMossImage({
    model,
    prompt: request.prompt,
    size: { width: request.width, height: request.height },
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
    ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
    enhance: request.enhance,
    watermark: request.watermark,
  }).pipe(Effect.mapError((): "invalid" => "invalid"));
  return (key: string) => mossDraw(key, prepared);
});

/** The vendor an account is of, by the adapter it names. */
type Adapter = ProviderSettings["connections"][number]["adapter"];

/** How each vendor draws, by adapter; one with no image use has none. */
const imageCalls: Record<Adapter, ImageCall | undefined> = { moss: mossImage };

/** What an account can be asked, with its key, the account's model and the Provider's own HttpClient sealed in; every
 * answer is in the capability's own shapes (vendors.ts). */
export interface Calls {
  readonly speech: {
    /** Whether the model takes the request, and a stream only from a model that streams; nothing is sent. */
    readonly check: (request: SpeechRequest & { readonly streaming: boolean }) => Effect.Effect<void, InvalidRequest>;
    readonly generate: (request: SpeechRequest) => Effect.Effect<GeneratedAudio, AudioFailure>;
    /** Starts the speech as a task the vendor runs; its ID, to ask after with `tasks.get`. */
    readonly createTask: (request: SpeechRequest) => Effect.Effect<string, AudioFailure>;
    readonly stream: (request: SpeechRequest) => Stream.Stream<SpeechEvent, AudioFailure>;
  };
  readonly speakers: {
    readonly check: (request: SpeakersRequest) => Effect.Effect<void, InvalidRequest>;
    readonly createTask: (request: SpeakersRequest) => Effect.Effect<string, AudioFailure>;
  };
  readonly voiceDesign: {
    readonly check: (request: VoiceDesignRequest) => Effect.Effect<void, InvalidRequest>;
    readonly createTask: (request: VoiceDesignRequest) => Effect.Effect<string, AudioFailure>;
  };
  readonly transcription: {
    /** Whether the model takes the request, and a stream only from a model that streams; nothing is sent. */
    readonly check: (request: TranscriptionRequest & { readonly streaming: boolean }) => Effect.Effect<void, InvalidRequest>;
    readonly createTask: (request: TranscriptionRequest) => Effect.Effect<string, AudioFailure>;
    readonly stream: (request: TranscriptionRequest) => Stream.Stream<TranscriptionEvent, AudioFailure>;
  };
  readonly understanding: {
    readonly check: (request: UnderstandingRequest) => Effect.Effect<void, InvalidRequest>;
    readonly ask: (request: UnderstandingRequest) => Effect.Effect<T.MediaUnderstandingResult, UnderstandingFailure>;
  };
  readonly voices: { readonly clone: (request: CloneRequest) => Effect.Effect<T.MediaAudioVoice, AudioFailure> };
  /** Audio tasks of any kind, by the ID their creation gave. */
  readonly tasks: { readonly get: (id: string) => Effect.Effect<AudioTask, AudioFailure> };
  readonly files: {
    readonly upload: (file: FileUpload) => Effect.Effect<UploadedFile, FileFailure>;
    /** Deletes the vendor's copy; one already gone counts as deleted. */
    readonly delete: (id: string) => Effect.Effect<void, FileFailure>;
  };
  /** A realtime line (Live, Vision) to the account's model, through the given transport or the vendor's own. */
  readonly realtime: {
    readonly connect: (on: RealtimeEvents, transport?: RealtimeTransport) => RealtimeLink;
    /** The text with the key taken out: what the vendor sends back may echo it. */
    readonly redact: (text: string) => string;
    readonly verify: (transport?: RealtimeTransport) => Effect.Effect<RealtimeCheck>;
  };
}

/** The bound dictation model, and how to make its transcriber for one recording's format; the key is sealed in. */
export interface Dictation {
  readonly model: string;
  readonly transcriber: (format: TranscriptionFormat) => Effect.Effect<Effect.Success<ReturnType<typeof transcriptionModel>>, never, Scope.Scope>;
}

/** An account as it was when it was bound: the connection, the settings revision, the model, and the key's
 * fingerprint (a stored task keeps it to tell later whether the account still has the key it started with). */
export interface Account extends Calls {
  readonly connection: string;
  readonly revision: number;
  readonly model: string;
  readonly fingerprint: string;
}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

const audioFailure = (error: Effect.Error<ReturnType<typeof getMossAudioTask>>) =>
  AudioFailure.make({
    // Not sent is refused too: nothing was asked of the vendor, so nothing can have been made or paid for.
    outcome: error.outcome === "Unknown" ? "Unknown" : "Rejected",
    retryable:
      error.reason === "Network" || error.reason === "Timeout" || (error.reason === "HttpStatus" && (error.status === 429 || (error.status ?? 0) >= 500)),
  });

const fileFailure = (error: Effect.Error<ReturnType<typeof uploadMossFile>>) =>
  FileFailure.make({ outcome: error.outcome === "Unknown" ? "Unknown" : "Rejected" });

const mossTask = (task: MossAudioTask): AudioTask => {
  const kind = task.object === "audio.speech" ? "speech" : task.object === "audio.voice_generation" ? "voiceGeneration" : "transcription";
  switch (task.status) {
    case "PENDING":
    case "PROCESSING":
      return { kind, status: "waiting" };
    case "FAILED":
      return { kind, status: "failed" };
    case "SUCCESS":
      switch (task.object) {
        case "audio.speech":
        case "audio.voice_generation":
          return {
            kind: task.object === "audio.speech" ? "speech" : "voiceGeneration",
            status: "ready",
            url: task.url,
            format: task.format,
            contentType: task.contentType,
            ...(task.usage !== undefined ? { usage: task.usage } : {}),
          };
        case "audio.transcription":
          return {
            kind: "transcription",
            status: "ready",
            text: task.text,
            ...(task.segments !== undefined ? { segments: task.segments } : {}),
            ...(task.usage !== undefined ? { usage: task.usage } : {}),
          };
      }
  }
};

/** MOSS's flash models are the ones that stream speech. */
const mossStreamingSpeech: ReadonlySet<string> = new Set(["moss-tts-1.5-flash", "moss-tts-1.5-flash-2026-06-26"]);

const mossCalls =
  (http: HttpClient.HttpClient) =>
  (key: string, model: string): Calls => {
    const sealed = Effect.provideService(HttpClient.HttpClient, http);
    const synthesis = (request: SpeechRequest) => ({ model, text: request.text, voice: request.voice, format: request.format });
    const dialogue = (request: SpeakersRequest) => ({ model, speakers: request.speakers, segments: request.segments, format: request.format });
    const design = (request: VoiceDesignRequest) => ({ model, text: request.text, instruction: request.instruction, format: request.format });
    const transcript = (request: TranscriptionRequest) => ({
      model,
      fileId: request.fileId,
      ...(request.diarize !== undefined ? { diarize: request.diarize } : {}),
      ...(request.keyterms !== undefined ? { keyterms: request.keyterms } : {}),
    });
    const question = (request: UnderstandingRequest) => ({ model, text: request.text, media: request.media, maxOutputTokens: request.maxOutputTokens });
    const taskId = (result: { readonly taskId: string }) => result.taskId;
    return {
      speech: {
        check: (request) =>
          prepareMossSpeech(synthesis(request)).pipe(
            Effect.mapError(() => InvalidRequest.make()),
            Effect.flatMap(() => (request.streaming && !mossStreamingSpeech.has(model) ? Effect.fail(InvalidRequest.make()) : Effect.void)),
          ),
        generate: (request) =>
          generateMossSpeech(key, synthesis(request)).pipe(
            sealed,
            Effect.mapBoth({
              onSuccess: (result) => ({
                url: result.url,
                format: result.format,
                contentType: result.contentType,
                ...(result.usage !== undefined ? { usage: result.usage } : {}),
              }),
              onFailure: audioFailure,
            }),
          ),
        createTask: (request) =>
          createMossSpeechTask(key, synthesis(request)).pipe(sealed, Effect.mapBoth({ onSuccess: (result) => result.taskId, onFailure: audioFailure })),
        stream: (request) => streamMossSpeech(key, synthesis(request)).pipe(Stream.provideService(HttpClient.HttpClient, http), Stream.mapError(audioFailure)),
      },
      speakers: {
        check: (request) =>
          prepareMossSpeakers(dialogue(request)).pipe(
            Effect.mapError(() => InvalidRequest.make()),
            Effect.asVoid,
          ),
        createTask: (request) => createMossSpeakersTask(key, dialogue(request)).pipe(sealed, Effect.mapBoth({ onSuccess: taskId, onFailure: audioFailure })),
      },
      voiceDesign: {
        check: (request) =>
          prepareMossVoiceDesign(design(request)).pipe(
            Effect.mapError(() => InvalidRequest.make()),
            Effect.asVoid,
          ),
        createTask: (request) => createMossVoiceDesignTask(key, design(request)).pipe(sealed, Effect.mapBoth({ onSuccess: taskId, onFailure: audioFailure })),
      },
      transcription: {
        check: (request) =>
          prepareMossTranscription(transcript(request)).pipe(
            Effect.mapError(() => InvalidRequest.make()),
            // MOSS streams transcripts only from its diarizing models.
            Effect.flatMap(() =>
              request.streaming && !Str.startsWith("moss-transcribe-diarize-pro")(model) ? Effect.fail(InvalidRequest.make()) : Effect.void,
            ),
          ),
        createTask: (request) =>
          createMossTranscriptionTask(key, transcript(request)).pipe(sealed, Effect.mapBoth({ onSuccess: taskId, onFailure: audioFailure })),
        stream: (request) =>
          streamMossTranscription(key, transcript(request)).pipe(Stream.provideService(HttpClient.HttpClient, http), Stream.mapError(audioFailure)),
      },
      understanding: {
        check: (request) =>
          prepareMossUnderstanding(question(request)).pipe(
            Effect.mapError(() => InvalidRequest.make()),
            Effect.asVoid,
          ),
        ask: (request) =>
          understandMossMedia(key, question(request)).pipe(
            sealed,
            Effect.mapBoth({
              onSuccess: ({ id: _responseId, ...result }) => result,
              onFailure: (error) => UnderstandingFailure.make({ outcome: error.outcome === "Unknown" ? "Unknown" : "Rejected" }),
            }),
          ),
      },
      voices: {
        clone: (request) =>
          createMossVoice(key, {
            audio: request.audio,
            filename: request.filename,
            durationSeconds: request.durationSeconds,
            ...(request.name !== undefined ? { name: request.name } : {}),
          }).pipe(sealed, Effect.mapError(audioFailure)),
      },
      tasks: { get: (id) => getMossAudioTask(key, id).pipe(sealed, Effect.mapBoth({ onSuccess: mossTask, onFailure: audioFailure })) },
      realtime: {
        connect: (on, transport = nodeMossTransport) => transport.connect(key, on, model),
        redact: (text) => Str.replaceAll(key, "[redacted]")(text),
        verify: (transport) => verifyMoss(key, transport, model),
      },
      files: {
        upload: (file) =>
          uploadMossFile(key, { file: file.file, filename: file.filename, purpose: file.purpose }).pipe(
            sealed,
            Effect.mapBoth({
              onSuccess: (result) => ({
                id: result.id,
                state: result.status === "processed" || result.status === "active" ? "ready" : result.status === "failed" ? "rejected" : "unknown",
              }),
              onFailure: fileFailure,
            }),
          ),
        delete: (id) =>
          deleteMossFile(key, id).pipe(
            sealed,
            Effect.asVoid,
            Effect.catchTag("MossFileError", (error) => (error.status === 404 ? Effect.void : Effect.fail(fileFailure(error)))),
          ),
      },
    };
  };

const refusal = (error: MossModelError | Effect.Error<ReturnType<typeof listMossVoices>>): Refused => {
  const reason = () => {
    switch (error.reason) {
      case "InvalidInput":
        return t("server.provider.voiceQuery");
      case "Credentials":
        return t("server.provider.noKey");
      case "Network":
        return t("server.provider.network");
      case "Timeout":
        return t("server.provider.timeout");
      case "InvalidResponse":
        return t("server.provider.invalidResponse");
      case "TooLarge":
        return t("server.provider.tooLarge");
      case "HttpStatus":
        switch (error.status) {
          case 401:
            return t("server.provider.authentication");
          case 403:
            return t("server.provider.forbidden");
          case 429:
            return t("server.provider.rateLimited");
          default:
            return t("server.provider.httpStatus", { status: error.status ?? 0 });
        }
    }
  };
  return { _tag: "Refused", reason: reason() };
};

export class Provider extends Context.Service<
  Provider,
  {
    readonly status: () => T.ProviderStatus;
    readonly update: (input: T.ProviderUpdate) => Effect.Effect<T.ProviderStatus, Refused>;
    readonly voices: (input: T.ProviderVoiceRequest) => Effect.Effect<T.ProviderVoiceListing, Refused>;
    /** A stored task's account again, by its connection, with its model: the calls with the key it has now, at the
     * current revision. Compare `fingerprint` with the one the task kept to tell whether the key changed. */
    readonly account: (stored: { readonly connection: string; readonly model: string }) => Effect.Effect<Account, Refused>;
    /** The account bound to speak, as it is now. */
    readonly speech: () => Effect.Effect<Account, Refused>;
    readonly models: (input: T.ProviderModelRequest) => Effect.Effect<T.ProviderModelListing, Refused>;
    /** The dictation the owner set: a model of an account's, or their own compatible endpoint. */
    readonly dictation: () => Effect.Effect<Dictation, Refused>;
    /** Image generation, whichever vendor the bound account is of: the request checked against the bound model, and
     * the account as it is now (a queued task keeps it), with the call to run later. */
    readonly image: (request: ImageRequest) => Effect.Effect<BoundImage, Refused>;
    /** The account bound to understand images and video, as it is now. */
    readonly understanding: () => Effect.Effect<Account, Refused>;
    /** The account bound for each audio use, as it is now. */
    readonly speakers: () => Effect.Effect<Account, Refused>;
    readonly voiceDesign: () => Effect.Effect<Account, Refused>;
    readonly transcription: () => Effect.Effect<Account, Refused>;
    /** The account bound for each realtime line, as it is now. */
    readonly vision: () => Effect.Effect<Account, Refused>;
    readonly live: () => Effect.Effect<Account, Refused>;
  }
>()("@vibevalley/server/provider/provider") {
  static readonly layer = Layer.effect(
    Provider,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const settings = yield* Setting;
  const http = yield* HttpClient.HttpClient;
  const clients: Record<Adapter, (key: string, model: string) => Calls> = { moss: mossCalls(http) };
  const bind = (connection: { readonly id: string; readonly adapter: Adapter; readonly key: string }, revision: number, model: string): Account => ({
    connection: connection.id,
    revision,
    model,
    fingerprint: fingerprint(connection.key),
    ...clients[connection.adapter](connection.key, model),
  });
  const capable = Effect.fnUntraced(function* (use: "speakers" | "voiceDesign" | "transcription" | "vision" | "live"): Effect.fn.Return<Account, Refused> {
    const config = settings.providers();
    const bound = bindingOf(use)(config);
    const capability = t(`server.provider.use.${use}`);
    if (!bound.ready) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.capabilityUnbound", { capability }) });
    if (vendors[bound.connection.adapter][use]?.models.includes(bound.model) !== true)
      return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.capabilityModel", { capability }) });
    return bind(bound.connection, config.revision, bound.model);
  });
  const transcriber =
    (connection: { readonly url: string; readonly model: string; readonly key: string }): Dictation["transcriber"] =>
    (format) =>
      transcriptionModel(connection, format).pipe(Effect.provideService(HttpClient.HttpClient, http));
  return Provider.of({
    status: () => providerStatus(settings.providers()),
    speakers: Effect.fn("Provider.speakers")(function* () {
      return yield* capable("speakers");
    }),
    voiceDesign: Effect.fn("Provider.voiceDesign")(function* () {
      return yield* capable("voiceDesign");
    }),
    transcription: Effect.fn("Provider.transcription")(function* () {
      return yield* capable("transcription");
    }),
    vision: Effect.fn("Provider.vision")(function* () {
      return yield* capable("vision");
    }),
    live: Effect.fn("Provider.live")(function* () {
      return yield* capable("live");
    }),
    update: Effect.fn("Provider.update")(function* (input) {
      const next = yield* settings
        .updateProviders((current) => connectionsOver(current, input))
        .pipe(Effect.mapError((error): Refused => ({ _tag: "Refused", reason: error.message })));
      return providerStatus(next);
    }),
    models: Effect.fn("Provider.models")(function* (input) {
      const config = settings.providers();
      if (input.revision !== config.revision) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.changed") });
      const connection = boundConnection(config, input.connection);
      if (!connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.noKey") });
      const models = yield* mossModels(connection.key).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(refusal));
      if (settings.providers().revision !== config.revision) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.changed") });
      return { connection: connection.id, revision: config.revision, models };
    }),
    voices: Effect.fn("Provider.voices")(function* ({ connection: id, revision, ...pagination }) {
      const config = settings.providers();
      if (revision !== config.revision) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.changed") });
      const connection = boundConnection(config, id);
      if (!connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.noKey") });
      const listing = yield* listMossVoices(connection.key, pagination).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(refusal));
      if (settings.providers().revision !== config.revision) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.changed") });
      return { connection: id, revision, ...listing };
    }),
    account: Effect.fn("Provider.account")(function* (stored) {
      const config = settings.providers();
      const connection = boundConnection(config, stored.connection);
      if (!connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.noKey") });
      return bind(connection, config.revision, stored.model);
    }),
    speech: Effect.fn("Provider.speech")(function* () {
      const config = settings.providers();
      const bound = bindingOf("speech")(config);
      if (!bound.ready) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.speechUnbound") });
      if (vendors[bound.connection.adapter].speech?.models.includes(bound.model) !== true)
        return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.speechModel") });
      return bind(bound.connection, config.revision, bound.model);
    }),
    dictation: Effect.fn("Provider.dictation")(function* () {
      const own = settings.dictation();
      if (own?.via === "own") return { model: own.model, transcriber: transcriber(own) };
      if (!own) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.voice.dictation.unset") });
      const bound = bindingOf("dictation")(settings.providers());
      if (!bound.ready) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.unbound") });
      return { model: bound.model, transcriber: transcriber({ url: mossTranscription.url, model: bound.model, key: bound.connection.key }) };
    }),
    image: Effect.fn("Provider.image")(function* (request: ImageRequest) {
      const config = settings.providers();
      const bound = bindingOf("image")(config);
      if (!bound.ready) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.imageUnbound") });
      const adapter = bound.connection.adapter;
      const call = imageCalls[adapter];
      if (call === undefined || vendors[adapter].image?.models.includes(bound.model) !== true)
        return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.imageModel") });
      const run = yield* call(bound.model, request).pipe(Effect.mapError((): Refused => ({ _tag: "Refused", reason: t("server.media.invalid") })));
      // The key as it is now: a task queued with it keeps it, whatever the account has later.
      return {
        connection: bound.connection.id,
        revision: config.revision,
        model: bound.model,
        run: run(bound.connection.key).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      };
    }),
    understanding: Effect.fn("Provider.understanding")(function* () {
      const config = settings.providers();
      const bound = bindingOf("understanding")(config);
      if (!bound.ready) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.understandingUnbound") });
      if (vendors[bound.connection.adapter].understanding?.models.includes(bound.model) !== true)
        return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.understandingModel") });
      return bind(bound.connection, config.revision, bound.model);
    }),
  });
});
