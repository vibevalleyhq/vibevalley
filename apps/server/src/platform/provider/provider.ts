import { createHash } from "node:crypto";

import { z } from "zod";

import { isAbort } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import type { Secret } from "@vibevalley/protocol/schema";
import { getMossAudioTask, type MossAudioTask } from "@vibevalley/provider/moss/audio-tasks";
import { deleteMossFile, uploadMossFile } from "@vibevalley/provider/moss/files";
import { generateMossImage, prepareMossImage } from "@vibevalley/provider/moss/image";
import { mossModels } from "@vibevalley/provider/moss/models";
import { makeMossTransport, verifyMoss } from "@vibevalley/provider/moss/server";
import { createMossSpeakersTask, prepareMossSpeakers } from "@vibevalley/provider/moss/speakers";
import { createMossSpeechTask, generateMossSpeech, prepareMossSpeech } from "@vibevalley/provider/moss/speech";
import { streamMossSpeech } from "@vibevalley/provider/moss/speech-stream";
import { createMossTranscriptionTask, prepareMossTranscription } from "@vibevalley/provider/moss/transcription";
import { streamMossTranscription } from "@vibevalley/provider/moss/transcription-stream";
import { prepareMossUnderstanding, understandMossMedia } from "@vibevalley/provider/moss/understanding";
import { createMossVoiceDesignTask, prepareMossVoiceDesign } from "@vibevalley/provider/moss/voice-design";
import { createMossVoice, listMossVoices } from "@vibevalley/provider/moss/voices";
import { mossTranscription, type TranscriptionFormat, transcriptionModel } from "@vibevalley/provider/transcription";

import { type ApiError, BizCode, bizError } from "#/base/errors.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { bindingOf, boundConnection, type ProviderSettings } from "#/platform/setting/provider.ts";
import type { Setting } from "#/platform/setting/setting.ts";

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

export interface BoundImage {
  readonly connection: string;
  readonly revision: number;
  readonly model: string;
  /** Throws ImageFailure when the vendor refused it or its answer is unknown. */
  readonly run: (signal?: AbortSignal) => Promise<GeneratedImage>;
}

type Adapter = ProviderSettings["connections"][number]["adapter"];

export interface Calls {
  readonly speech: {
    /** Throws InvalidRequest. */
    readonly check: (request: SpeechRequest & { readonly streaming: boolean }) => Promise<void>;
    /** The rest throw AudioFailure. */
    readonly generate: (request: SpeechRequest, signal?: AbortSignal) => Promise<GeneratedAudio>;
    readonly createTask: (request: SpeechRequest, signal?: AbortSignal) => Promise<string>;
    readonly stream: (request: SpeechRequest, signal?: AbortSignal) => AsyncIterable<SpeechEvent>;
  };
  readonly speakers: {
    readonly check: (request: SpeakersRequest) => Promise<void>;
    readonly createTask: (request: SpeakersRequest, signal?: AbortSignal) => Promise<string>;
  };
  readonly voiceDesign: {
    readonly check: (request: VoiceDesignRequest) => Promise<void>;
    readonly createTask: (request: VoiceDesignRequest, signal?: AbortSignal) => Promise<string>;
  };
  readonly transcription: {
    readonly check: (request: TranscriptionRequest & { readonly streaming: boolean }) => Promise<void>;
    readonly createTask: (request: TranscriptionRequest, signal?: AbortSignal) => Promise<string>;
    readonly stream: (request: TranscriptionRequest, signal?: AbortSignal) => AsyncIterable<TranscriptionEvent>;
  };
  readonly understanding: {
    readonly check: (request: UnderstandingRequest) => Promise<void>;
    /** Throws UnderstandingFailure. */
    readonly ask: (request: UnderstandingRequest, signal?: AbortSignal) => Promise<NonNullable<T.MediaUnderstandingJob["result"]>>;
  };
  readonly voices: { readonly clone: (request: CloneRequest, signal?: AbortSignal) => Promise<T.ProviderVoiceListing["voices"][number]> };
  readonly tasks: { readonly get: (id: string, signal?: AbortSignal) => Promise<AudioTask> };
  readonly files: {
    /** Throws FileFailure. */
    readonly upload: (file: FileUpload, signal?: AbortSignal) => Promise<UploadedFile>;
    /** 404 counts as already deleted. */
    readonly delete: (id: string, signal?: AbortSignal) => Promise<void>;
  };
  readonly realtime: {
    readonly connect: (on: RealtimeEvents, transport?: RealtimeTransport) => RealtimeLink;
    /** Strips the key from echoed vendor error text. */
    readonly redact: (text: string) => string;
    readonly verify: (transport?: RealtimeTransport) => Promise<RealtimeCheck>;
  };
}

export interface Dictation {
  readonly model: string;
  readonly transcriber: (format: TranscriptionFormat) => Promise<ReturnType<typeof transcriptionModel>>;
}

export interface Account extends Calls {
  readonly connection: string;
  readonly revision: number;
  readonly model: string;
  readonly fingerprint: string;
}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

/** What a vendor's own failure says (its error classes are the package's own); undefined for anything else, which goes on up as it is. */
const VendorError = z.object({
  reason: z.enum(["Credentials", "InvalidInput", "Network", "Timeout", "HttpStatus", "InvalidResponse", "TooLarge"]),
  outcome: z.enum(["NotSubmitted", "Rejected", "Unknown"]),
  status: z.number().optional(),
});
const vendorError = (e: unknown) => {
  if (!(e instanceof Error)) return undefined;
  const got = VendorError.safeParse(e);
  return got.success ? got.data : undefined;
};

// NotSent means nothing reached the vendor, so nothing can have been billed.
const outcomeOf = (error: { readonly outcome: string }) => (error.outcome === "Unknown" ? "Unknown" : "Rejected");

/** work, a vendor's failure thrown as the module's own failure. */
const mapped = async <A>(work: Promise<A>, as: (error: NonNullable<ReturnType<typeof vendorError>>) => Error): Promise<A> => {
  try {
    return await work;
  } catch (e) {
    const error = vendorError(e);
    throw error === undefined ? e : as(error);
  }
};

const audioFailure = (error: NonNullable<ReturnType<typeof vendorError>>) =>
  new AudioFailure({
    outcome: outcomeOf(error),
    retryable:
      error.reason === "Network" || error.reason === "Timeout" || (error.reason === "HttpStatus" && (error.status === 429 || (error.status ?? 0) >= 500)),
  });

const fileFailure = (error: NonNullable<ReturnType<typeof vendorError>>) => new FileFailure({ outcome: outcomeOf(error) });

/** A check: whatever the vendor's preparation refuses is an InvalidRequest. */
const checked = async (prepare: Promise<unknown>, also = true) => {
  await mapped(prepare, () => new InvalidRequest());
  if (!also) throw new InvalidRequest();
};

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

/** Which call to a vendor it is: what its logs say of it, never the key. */
interface CallSite {
  readonly vendor: Adapter;
  readonly connection: string;
  readonly model: string;
}

interface VendorHttp {
  readonly fetch: typeof fetch;
  readonly clock: Time;
  readonly log: Logger;
}

const siteWords = (site: CallSite) => `(vendor ${site.vendor}, connection ${site.connection}, model ${site.model})`;

/** A call to a vendor: a failure other than the caller's abort is logged once, with the call and never the key. */
const vendorCall =
  (http: VendorHttp, site: CallSite) =>
  (what: string) =>
  async <A>(
    call: (http: { readonly fetch: typeof fetch; readonly clock: Time; readonly signal?: AbortSignal }) => Promise<A>,
    signal?: AbortSignal,
  ): Promise<A> => {
    try {
      return await call({ fetch: http.fetch, clock: http.clock, ...(signal !== undefined ? { signal } : {}) });
    } catch (e) {
      if (!isAbort(e, signal)) http.log.warn(`provider: ${site.vendor} ${what} failed ${siteWords(site)}`, e);
      throw e;
    }
  };

/** A stream from a vendor, logged as vendorCall logs. */
const vendorStream = (http: VendorHttp, site: CallSite) => (what: string) =>
  async function* <A>(
    stream: (http: { readonly fetch: typeof fetch; readonly clock: Time; readonly signal?: AbortSignal }) => AsyncIterable<A>,
    signal?: AbortSignal,
  ): AsyncGenerator<A> {
    try {
      yield* stream({ fetch: http.fetch, clock: http.clock, ...(signal !== undefined ? { signal } : {}) });
    } catch (e) {
      if (!isAbort(e, signal)) http.log.warn(`provider: ${site.vendor} ${what} failed ${siteWords(site)}`, e);
      throw e;
    }
  };

/** A stream's vendor failures thrown as the module's own. */
async function* mappedStream<A>(stream: AsyncIterable<A>, as: (error: NonNullable<ReturnType<typeof vendorError>>) => Error): AsyncGenerator<A> {
  try {
    yield* stream;
  } catch (e) {
    const error = vendorError(e);
    throw error === undefined ? e : as(error);
  }
}

const mossStreamingSpeech: ReadonlySet<string> = new Set(["moss-tts-1.5-flash", "moss-tts-1.5-flash-2026-06-26"]);

const mossCalls = (http: VendorHttp) => {
  const defaultTransport = makeMossTransport(http.fetch, http.clock);
  return (key: string, model: string, connection: string): Calls => {
    const sealed = vendorCall(http, { vendor: "moss", connection, model });
    const streamed = vendorStream(http, { vendor: "moss", connection, model });
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
    return {
      speech: {
        check: (request) => checked(prepareMossSpeech(synthesis(request)), !request.streaming || mossStreamingSpeech.has(model)),
        generate: async (request, signal) => {
          const result = await mapped(
            sealed("speech.generate")((h) => generateMossSpeech(key, synthesis(request), h), signal),
            audioFailure,
          );
          return {
            url: result.url,
            format: result.format,
            contentType: result.contentType,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
          };
        },
        createTask: async (request, signal) =>
          (
            await mapped(
              sealed("speech.createTask")((h) => createMossSpeechTask(key, synthesis(request), h), signal),
              audioFailure,
            )
          ).taskId,
        stream: (request, signal) =>
          mappedStream(
            streamed("speech.stream")((h) => streamMossSpeech(key, synthesis(request), h), signal),
            audioFailure,
          ),
      },
      speakers: {
        check: (request) => checked(prepareMossSpeakers(dialogue(request))),
        createTask: async (request, signal) =>
          (
            await mapped(
              sealed("speakers.createTask")((h) => createMossSpeakersTask(key, dialogue(request), h), signal),
              audioFailure,
            )
          ).taskId,
      },
      voiceDesign: {
        check: (request) => checked(prepareMossVoiceDesign(design(request))),
        createTask: async (request, signal) =>
          (
            await mapped(
              sealed("voiceDesign.createTask")((h) => createMossVoiceDesignTask(key, design(request), h), signal),
              audioFailure,
            )
          ).taskId,
      },
      transcription: {
        check: (request) => checked(prepareMossTranscription(transcript(request)), !request.streaming || model.startsWith("moss-transcribe-diarize-pro")),
        createTask: async (request, signal) =>
          (
            await mapped(
              sealed("transcription.createTask")((h) => createMossTranscriptionTask(key, transcript(request), h), signal),
              audioFailure,
            )
          ).taskId,
        stream: (request, signal) =>
          mappedStream(
            streamed("transcription.stream")((h) => streamMossTranscription(key, transcript(request), h), signal),
            audioFailure,
          ),
      },
      understanding: {
        check: (request) => checked(prepareMossUnderstanding(question(request))),
        ask: async (request, signal) => {
          const { id: _responseId, ...result } = await mapped(
            sealed("understanding.ask")((h) => understandMossMedia(key, question(request), h), signal),
            (error) => new UnderstandingFailure({ outcome: outcomeOf(error) }),
          );
          return result;
        },
      },
      voices: {
        clone: (request, signal) =>
          mapped(
            sealed("voices.clone")(
              (h) =>
                createMossVoice(
                  key,
                  {
                    audio: request.audio,
                    filename: request.filename,
                    durationSeconds: request.durationSeconds,
                    ...(request.name !== undefined ? { name: request.name } : {}),
                  },
                  h,
                ),
              signal,
            ),
            audioFailure,
          ),
      },
      tasks: {
        get: async (id, signal) =>
          mossTask(
            await mapped(
              sealed("tasks.get")((h) => getMossAudioTask(key, id, h), signal),
              audioFailure,
            ),
          ),
      },
      realtime: {
        connect: (on, transport = defaultTransport) => transport.connect(key, on, model),
        redact: (text) => text.replaceAll(key, "[redacted]"),
        verify: (transport = defaultTransport) => verifyMoss(key, transport, model, http.clock),
      },
      files: {
        upload: async (file, signal) => {
          const result = await mapped(
            sealed("files.upload")((h) => uploadMossFile(key, { file: file.file, filename: file.filename, purpose: file.purpose }, h), signal),
            fileFailure,
          );
          return {
            id: result.id,
            state: result.status === "processed" || result.status === "active" ? "ready" : result.status === "failed" ? "rejected" : "unknown",
          };
        },
        delete: async (id, signal) => {
          try {
            await sealed("files.delete")((h) => deleteMossFile(key, id, h), signal);
          } catch (e) {
            const error = vendorError(e);
            if (error === undefined) throw e;
            if (error.status === 404) return;
            throw fileFailure(error);
          }
        },
      },
    };
  };
};

const refuse = (reason: string): ApiError => bizError(BizCode.ProviderRefused, reason);

/** A model or voice listing's failure, in the user's words; anything else goes on up as it is. */
const refusal = (e: unknown): unknown => {
  const error = vendorError(e) ?? (e instanceof Error && e.name === "MossModelError" ? vendorModelError(e) : undefined);
  if (error === undefined) return e;
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
  return refuse(reason());
};

/** MossModelError has a reason and maybe a status, but no outcome. */
const vendorModelError = (e: Error) => {
  const got = VendorError.omit({ outcome: true }).safeParse(e);
  return got.success ? got.data : undefined;
};

/** An image call checked now (it throws what the vendor's preparation refuses), to run later with the key. */
type ImageCall = (
  model: string,
  request: ImageRequest,
) => Promise<(key: string, http: { readonly fetch: typeof fetch; readonly clock: Time; readonly signal?: AbortSignal }) => Promise<GeneratedImage>>;

const mossImage: ImageCall = async (model, request) => {
  const input = {
    model,
    prompt: request.prompt,
    size: { width: request.width, height: request.height },
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
    ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
    enhance: request.enhance,
    watermark: request.watermark,
  };
  await prepareMossImage(input);
  return async (key, http) => {
    const result = await mapped(generateMossImage(key, input, http), (error) => new ImageFailure({ outcome: outcomeOf(error) }));
    return { url: result.url, usage: { images: result.usage.generated_images, width: result.usage.output_width, height: result.usage.output_height } };
  };
};

const imageCalls: Record<Adapter, ImageCall | undefined> = { moss: mossImage };

export interface Provider {
  readonly status: () => T.ProviderStatus;
  readonly update: (input: T.ProviderUpdate) => Promise<T.ProviderStatus>;
  readonly voices: (input: T.ProviderVoiceRequest, signal?: AbortSignal) => Promise<T.ProviderVoiceListing>;
  /** Rebinds by stored connection ID; compare `fingerprint` against the task's snapshot to detect key rotation. */
  readonly account: (stored: { readonly connection: string; readonly model: string }) => Promise<Account>;
  readonly speech: () => Promise<Account>;
  readonly models: (input: T.ProviderModelRequest, signal?: AbortSignal) => Promise<T.ProviderModelListing>;
  readonly dictation: () => Promise<Dictation>;
  readonly image: (request: ImageRequest) => Promise<BoundImage>;
  readonly understanding: () => Promise<Account>;
  readonly speakers: () => Promise<Account>;
  readonly voiceDesign: () => Promise<Account>;
  readonly transcription: () => Promise<Account>;
  readonly vision: () => Promise<Account>;
  readonly live: () => Promise<Account>;
}

export interface ProviderDeps {
  readonly setting: Setting;
  readonly fetch: typeof fetch;
  readonly clock: Time;
  readonly log: Logger;
}

export async function makeProvider(deps: ProviderDeps): Promise<Provider> {
  const settings = deps.setting;
  const http: VendorHttp = { fetch: deps.fetch, clock: deps.clock, log: deps.log.child("provider") };
  const clients: Record<Adapter, (key: string, model: string, connection: string) => Calls> = { moss: mossCalls(http) };
  const bind = (connection: { readonly id: string; readonly adapter: Adapter; readonly key: Secret }, revision: number, model: string): Account => ({
    connection: connection.id,
    revision,
    model,
    fingerprint: fingerprint(connection.key.reveal()),
    ...clients[connection.adapter](connection.key.reveal(), model, connection.id),
  });
  const capable = async (use: "speakers" | "voiceDesign" | "transcription" | "vision" | "live"): Promise<Account> => {
    const config = settings.providers();
    const bound = bindingOf(use)(config);
    const capability = t(`server.provider.use.${use}`);
    if (!bound.ready) throw refuse(t("server.provider.capabilityUnbound", { capability }));
    if (vendors[bound.connection.adapter][use]?.models.includes(bound.model) !== true) throw refuse(t("server.provider.capabilityModel", { capability }));
    return bind(bound.connection, config.revision, bound.model);
  };
  const transcriber =
    (connection: { readonly url: string; readonly model: string; readonly key: string }): Dictation["transcriber"] =>
    async (format) =>
      transcriptionModel(connection, format, { fetch: http.fetch, clock: http.clock });
  return {
    status: () => providerStatus(settings.providers()),
    speakers: () => capable("speakers"),
    voiceDesign: () => capable("voiceDesign"),
    transcription: () => capable("transcription"),
    vision: () => capable("vision"),
    live: () => capable("live"),
    update: async (input) => {
      const next = await settings.updateProviders((current) => connectionsOver(current, input));
      return providerStatus(next);
    },
    models: async (input, signal) => {
      const config = settings.providers();
      if (input.revision !== config.revision) throw refuse(t("server.provider.changed"));
      const connection = boundConnection(config, input.connection);
      if (!connection) throw refuse(t("server.provider.noKey"));
      const call = vendorCall(http, { vendor: connection.adapter, connection: connection.id, model: "" })("models.list");
      const models = await call((h) => mossModels(connection.key.reveal(), h), signal).catch((e: unknown) => {
        throw refusal(e);
      });
      if (settings.providers().revision !== config.revision) throw refuse(t("server.provider.changed"));
      return { connection: connection.id, revision: config.revision, models: [...models] };
    },
    voices: async ({ connection: id, revision, ...pagination }, signal) => {
      const config = settings.providers();
      if (revision !== config.revision) throw refuse(t("server.provider.changed"));
      const connection = boundConnection(config, id);
      if (!connection) throw refuse(t("server.provider.noKey"));
      const call = vendorCall(http, { vendor: connection.adapter, connection: connection.id, model: "" })("voices.list");
      const listing = await call((h) => listMossVoices(connection.key.reveal(), pagination, h), signal).catch((e: unknown) => {
        throw refusal(e);
      });
      if (settings.providers().revision !== config.revision) throw refuse(t("server.provider.changed"));
      return { connection: id, revision, ...listing, voices: [...listing.voices] };
    },
    account: async (stored) => {
      const config = settings.providers();
      const connection = boundConnection(config, stored.connection);
      if (!connection) throw refuse(t("server.provider.noKey"));
      return bind(connection, config.revision, stored.model);
    },
    speech: async () => {
      const config = settings.providers();
      const bound = bindingOf("speech")(config);
      if (!bound.ready) throw refuse(t("server.provider.speechUnbound"));
      if (vendors[bound.connection.adapter].speech?.models.includes(bound.model) !== true) throw refuse(t("server.provider.speechModel"));
      return bind(bound.connection, config.revision, bound.model);
    },
    dictation: async () => {
      const own = settings.dictation();
      if (own?.via === "own") return { model: own.model, transcriber: transcriber({ url: own.url, model: own.model, key: own.key.reveal() }) };
      if (!own) throw refuse(t("server.voice.dictation.unset"));
      const bound = bindingOf("dictation")(settings.providers());
      if (!bound.ready) throw refuse(t("server.provider.unbound"));
      return {
        model: bound.model,
        transcriber: transcriber({ url: mossTranscription.url, model: bound.model, key: bound.connection.key.reveal() }),
      };
    },
    image: async (request) => {
      const config = settings.providers();
      const bound = bindingOf("image")(config);
      if (!bound.ready) throw refuse(t("server.provider.imageUnbound"));
      const adapter = bound.connection.adapter;
      const call = imageCalls[adapter];
      if (call === undefined || vendors[adapter].image?.models.includes(bound.model) !== true) throw refuse(t("server.provider.imageModel"));
      const run = await mapped(call(bound.model, request), () => refuse(t("server.media.invalid")));
      // Capture the key now so rotating the account later does not alter a queued task.
      const key = bound.connection.key.reveal();
      const sealed = vendorCall(http, { vendor: adapter, connection: bound.connection.id, model: bound.model })("image.generate");
      return { connection: bound.connection.id, revision: config.revision, model: bound.model, run: (signal) => sealed((h) => run(key, h), signal) };
    },
    understanding: async () => {
      const config = settings.providers();
      const bound = bindingOf("understanding")(config);
      if (!bound.ready) throw refuse(t("server.provider.understandingUnbound"));
      if (vendors[bound.connection.adapter].understanding?.models.includes(bound.model) !== true) throw refuse(t("server.provider.understandingModel"));
      return bind(bound.connection, config.revision, bound.model);
    },
  };
}
