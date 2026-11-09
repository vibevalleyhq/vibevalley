import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import type { Refused } from "@vibevalley/protocol/api";
import { mossImageModels } from "@vibevalley/provider/moss/image-models";
import { mossLiveModels } from "@vibevalley/provider/moss/live-models";
import { type MossModelError, mossModels } from "@vibevalley/provider/moss/models";
import { mossSpeakersModels } from "@vibevalley/provider/moss/speakers-models";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";
import { mossTranscriptionModels } from "@vibevalley/provider/moss/transcription-models";
import { mossUnderstandingModels } from "@vibevalley/provider/moss/understanding-models";
import { mossVisionModels } from "@vibevalley/provider/moss/vision-models";
import { mossVoiceDesignModels } from "@vibevalley/provider/moss/voice-design-models";
import { listMossVoices } from "@vibevalley/provider/moss/voices";
import { mossTranscription } from "@vibevalley/provider/transcription";

import { boundConnection } from "#/setting/provider.ts";
import { Setting } from "#/setting/setting.ts";

import { connectionsOver, providerStatus } from "./connections.ts";

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

export interface UnderstandingAccount {
  readonly connection: string;
  readonly revision: number;
  readonly model: (typeof mossUnderstandingModels)[number];
  readonly key: string;
}

export interface ProviderAccount {
  readonly connection: string;
  readonly revision: number;
  readonly model: string;
  readonly key: string;
}

export class Provider extends Context.Service<
  Provider,
  {
    readonly status: () => T.ProviderStatus;
    readonly connection: (id: string) => Effect.Effect<{ readonly connection: string; readonly revision: number; readonly key: string }, Refused>;
    readonly update: (input: T.ProviderUpdate) => Effect.Effect<T.ProviderStatus, Refused>;
    readonly voices: (input: T.ProviderVoiceRequest) => Effect.Effect<T.ProviderVoiceListing, Refused>;
    readonly speech: () => Effect.Effect<
      { readonly connection: string; readonly revision: number; readonly model: (typeof mossSpeechModels)[number]; readonly key: string },
      Refused
    >;
    readonly models: (input: T.ProviderModelRequest) => Effect.Effect<T.ProviderModelListing, Refused>;
    readonly dictation: () => Effect.Effect<{ readonly url: string; readonly model: string; readonly key: string }, Refused>;
    readonly image: () => Effect.Effect<
      {
        readonly connection: string;
        readonly revision: number;
        readonly model: (typeof mossImageModels)[number];
        readonly key: string;
      },
      Refused
    >;
    readonly understanding: () => Effect.Effect<UnderstandingAccount, Refused>;
    readonly speakers: () => Effect.Effect<ProviderAccount, Refused>;
    readonly voiceDesign: () => Effect.Effect<ProviderAccount, Refused>;
    readonly transcription: () => Effect.Effect<ProviderAccount, Refused>;
    readonly vision: () => Effect.Effect<ProviderAccount, Refused>;
    readonly live: () => Effect.Effect<ProviderAccount, Refused>;
  }
>()("vibevalley/Provider") {
  static readonly layer = Layer.effect(
    Provider,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const settings = yield* Setting;
  const http = yield* HttpClient.HttpClient;
  const account = Effect.fnUntraced(function* (
    use: "speakers" | "voiceDesign" | "transcription" | "vision" | "live",
    models: readonly string[],
  ): Effect.fn.Return<ProviderAccount, Refused> {
    const config = settings.providers();
    const binding = config[use];
    const connection = boundConnection(config, binding?.connection ?? null);
    const capability = t(`server.provider.use.${use}`);
    if (!binding || !connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.capabilityUnbound", { capability }) });
    if (!models.includes(binding.model)) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.capabilityModel", { capability }) });
    return { connection: connection.id, revision: config.revision, model: binding.model, key: connection.key };
  });
  return Provider.of({
    status: () => providerStatus(settings.providers()),
    speakers: Effect.fn("Provider.speakers")(function* () {
      return yield* account("speakers", mossSpeakersModels);
    }),
    voiceDesign: Effect.fn("Provider.voiceDesign")(function* () {
      return yield* account("voiceDesign", mossVoiceDesignModels);
    }),
    transcription: Effect.fn("Provider.transcription")(function* () {
      return yield* account("transcription", mossTranscriptionModels);
    }),
    vision: Effect.fn("Provider.vision")(function* () {
      return yield* account("vision", mossVisionModels);
    }),
    live: Effect.fn("Provider.live")(function* () {
      return yield* account("live", mossLiveModels);
    }),
    connection: Effect.fn("Provider.connection")(function* (id) {
      const config = settings.providers();
      const connection = boundConnection(config, id);
      if (!connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.noKey") });
      return { connection: connection.id, revision: config.revision, key: connection.key };
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
    speech: Effect.fn("Provider.speech")(function* () {
      const config = settings.providers();
      const binding = config.speech;
      const connection = boundConnection(config, binding?.connection ?? null);
      if (!binding || !connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.speechUnbound") });
      const model = mossSpeechModels.find((id) => id === binding.model);
      if (!model) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.speechModel") });
      return { connection: connection.id, revision: config.revision, model, key: connection.key };
    }),
    dictation: Effect.fn("Provider.dictation")(function* () {
      const own = settings.dictation();
      if (own?.via === "own") return { url: own.url, model: own.model, key: own.key };
      if (!own) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.voice.dictation.unset") });
      const config = settings.providers();
      const binding = config.dictation;
      const connection = boundConnection(config, binding?.connection ?? null);
      if (!binding || !connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.unbound") });
      return { url: mossTranscription.url, model: binding.model, key: connection.key };
    }),
    image: Effect.fn("Provider.image")(function* () {
      const config = settings.providers();
      const binding = config.image;
      const connection = boundConnection(config, binding?.connection ?? null);
      if (!binding || !connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.imageUnbound") });
      const model = mossImageModels.find((id) => id === binding.model);
      if (!model) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.imageModel") });
      return { connection: connection.id, revision: config.revision, model, key: connection.key };
    }),
    understanding: Effect.fn("Provider.understanding")(function* () {
      const config = settings.providers();
      const binding = config.understanding;
      const connection = boundConnection(config, binding?.connection ?? null);
      if (!binding || !connection) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.understandingUnbound") });
      const model = mossUnderstandingModels.find((id) => id === binding.model);
      if (!model) return yield* Effect.fail<Refused>({ _tag: "Refused", reason: t("server.provider.understandingModel") });
      return { connection: connection.id, revision: config.revision, model, key: connection.key };
    }),
  });
});
