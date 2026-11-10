import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { ProviderUpdate } from "@vibevalley/protocol";
import { endpoints } from "@vibevalley/protocol/api";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";

import { providerHandlers } from "#/http/handlers/provider.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Setting } from "#/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";

import { type Account, type Dictation, Provider } from "./provider.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });

const config: ProviderUpdate = {
  revision: 0,
  connections: [
    { id: "first", name: "First", adapter: "moss", enabled: true, key: "test-first-private" },
    { id: "second", name: "Second", adapter: "moss", enabled: true, key: "test-second-private" },
  ],
  dictation: { connection: "first", model: "moss-transcribe-1.0" },
  image: null,
  understanding: null,
  speech: { connection: "second", model: "moss-tts-1.5-flash" },
  live: { connection: "first", model: "moss-live-1.0" },
  speakers: null,
  voiceDesign: null,
  transcription: null,
  vision: null,
};
const layer = (http: HttpClient.HttpClient) =>
  Provider.layer.pipe(
    Layer.provideMerge(Setting.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
/** A vendor that answers 503 and keeps each request's key: what a bound account's call sends, run once. */
const recording = () => {
  const keys: string[] = [];
  const http = HttpClient.make((request) => {
    keys.push(request.headers.authorization ?? "");
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 503 })));
  });
  const keyUsedBy = (account: Account | Dictation) =>
    ("tasks" in account
      ? account.tasks.get("task").pipe(Effect.ignore)
      : Effect.scoped(
          account
            .transcriber("wav")
            .pipe(
              Effect.flatMap((model) =>
                Effect.tryPromise({ try: () => model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/wav" }), catch: () => "not transcribed" }),
              ),
            ),
        ).pipe(Effect.ignore)
    ).pipe(Effect.map(() => keys.at(-1) ?? ""));
  return { http, keyUsedBy };
};
const page = {
  object: "list",
  data: [{ id: "voice-one", object: "audio.voice", name: "One", created_at: 1 }],
  first_id: "voice-one",
  last_id: "voice-one",
  has_more: true,
  next_cursor: "next-page",
};

it.effect.each(mossSpeechModels)("speech binding %s is independent, immutable and protected while in use", (model) => {
  const { http, keyUsedBy } = recording();
  return Effect.gen(function* () {
    const provider = yield* Provider;
    const speechFailure = yield* provider.speech().pipe(Effect.flip);
    expect(speechFailure).toMatchObject({ _tag: "Refused" });
    const input = { ...config, speech: { connection: "second", model } };
    const saved = yield* provider.update(input);
    expect(saved.speechModels).toEqual(mossSpeechModels);
    const frozen = yield* provider.speech();
    expect(frozen).toMatchObject({ connection: "second", revision: 1, model });
    const frozenKey = yield* keyUsedBy(frozen);
    expect(frozenKey).toBe("Bearer test-second-private");
    yield* notIn(frozen, "test-second-private");
    const dictation = yield* provider.dictation();
    const live = yield* provider.live();
    const others = [yield* keyUsedBy(dictation), yield* keyUsedBy(live)];
    expect(others).toEqual(["Bearer test-first-private", "Bearer test-first-private"]);
    yield* notIn(saved, "test-second-private");
    if (saved.speech) saved.speech.model = "caller-mutated";
    expect(provider.status().speech?.model).toBe(model);
    for (const connections of [
      config.connections.slice(0, 1),
      config.connections.map((c) => (c.id === "second" ? { ...c, key: null } : c)),
      config.connections.map((c) => (c.id === "second" ? { ...c, enabled: false } : c)),
    ]) {
      const updatedFailure = yield* provider.update({ ...input, revision: 1, connections }).pipe(Effect.flip);
      expect(updatedFailure).toMatchObject({ _tag: "Refused" });
      expect(provider.status().revision).toBe(1);
    }
    yield* provider.update({
      ...input,
      revision: 1,
      connections: config.connections.map((c) => (c.id === "second" ? { ...c, key: "test-rotated-private" } : c)),
    });
    const rotated = yield* provider.speech();
    const keys = [yield* keyUsedBy(rotated), yield* keyUsedBy(frozen)];
    expect(keys).toEqual(["Bearer test-rotated-private", "Bearer test-second-private"]);
    yield* provider.update({ ...input, revision: 2, speech: null });
    const speechFailure2 = yield* provider.speech().pipe(Effect.flip);
    expect(speechFailure2).toMatchObject({ _tag: "Refused" });
  }).pipe(Effect.provide(layer(http)));
});

it.effect("voice listing uses only the selected account and forwards one page, not the default binding", () => {
  const keys: (string | undefined)[] = [];
  const http = HttpClient.make((request) => {
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/voices");
    keys.push(request.headers.authorization);
    if (keys.length === 2) expect(request.urlParams.params).toContainEqual(["after", "next-page"]);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(page)));
  });
  return Effect.gen(function* () {
    const provider = yield* Provider;
    const api = yield* providerHandlers;
    expect(endpoints.find((endpoint) => endpoint.op === "provider.voice.list")?.can).toEqual(["user"]);
    yield* provider.update(config);
    const first = yield* api["provider.voice.list"]({ connection: "first", revision: 1 });
    expect(first).toEqual({
      connection: "first",
      revision: 1,
      voices: [{ id: "voice-one", name: "One", createdAtSeconds: 1 }],
      hasMore: true,
      nextCursor: "next-page",
    });
    const second = yield* api["provider.voice.list"]({ connection: "second", revision: 1, after: "next-page", limit: 1 });
    expect(second.connection).toBe("second");
    expect(keys).toEqual(["Bearer test-first-private", "Bearer test-second-private"]);
    yield* notIn([first, second], "private");
    for (const request of [
      { connection: "first", revision: 0 },
      { connection: "missing", revision: 1 },
      { connection: "first", revision: 1, after: "next-page", offset: 0 },
    ]) {
      const listFailure = yield* api["provider.voice.list"](request).pipe(Effect.flip);
      expect(listFailure).toMatchObject({ _tag: "Refused" });
    }
    expect(keys).toHaveLength(2);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: an in-flight voice listing cannot outlive the configuration revision that authorized it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
        return HttpClientResponse.fromWeb(request, Response.json(page));
      }),
    );
    yield* Effect.gen(function* () {
      const provider = yield* Provider;
      yield* provider.update(config);
      const fiber = yield* provider.voices({ connection: "second", revision: 1 }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* provider.update({ ...config, revision: 1, speech: null, connections: config.connections.slice(0, 1) });
      yield* Deferred.succeed(finish, undefined);
      const fiber2 = yield* Fiber.join(fiber);
      expect(fiber2).toMatchObject({ _tag: "Refused" });
      const voicesFailure = yield* provider.voices({ connection: "second", revision: 2 }).pipe(Effect.flip);
      expect(voicesFailure).toMatchObject({ _tag: "Refused" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("voice listing errors never expose the account secret or vendor response", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    yield* provider.update(config);
    const error = yield* provider.voices({ connection: "second", revision: 1 }).pipe(Effect.flip);
    expect(error._tag).toBe("Refused");
    yield* notIn(error, "private");
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: { message: "test-second-private", code: "private" } }, { status: 403 }))),
        ),
      ),
    ),
  ),
);
