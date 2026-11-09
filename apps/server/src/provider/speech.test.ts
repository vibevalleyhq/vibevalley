import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { ProviderUpdate } from "@vibevalley/protocol";
import { endpoints } from "@vibevalley/protocol/api";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";

import { providerHandlers } from "#/http/handlers/provider.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Setting } from "#/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";

import { Provider } from "./provider.ts";

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
const page = {
  object: "list",
  data: [{ id: "voice-one", object: "audio.voice", name: "One", created_at: 1 }],
  first_id: "voice-one",
  last_id: "voice-one",
  has_more: true,
  next_cursor: "next-page",
};

it.effect.each(mossSpeechModels)("speech binding %s is independent, immutable and protected while in use", (model) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    expect(yield* provider.speech().pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
    const input = { ...config, speech: { connection: "second", model } };
    const saved = yield* provider.update(input);
    expect(saved.speechModels).toEqual(mossSpeechModels);
    const frozen = yield* provider.speech();
    expect(frozen).toEqual({ connection: "second", revision: 1, model, key: "test-second-private" });
    expect((yield* provider.dictation()).key).toBe("test-first-private");
    expect((yield* provider.live()).key).toBe("test-first-private");
    expect(JSON.stringify(saved)).not.toContain("test-second-private");
    if (saved.speech) saved.speech.model = "caller-mutated";
    expect(provider.status().speech?.model).toBe(model);
    for (const connections of [
      config.connections.slice(0, 1),
      config.connections.map((c) => (c.id === "second" ? { ...c, key: null } : c)),
      config.connections.map((c) => (c.id === "second" ? { ...c, enabled: false } : c)),
    ]) {
      expect(yield* provider.update({ ...input, revision: 1, connections }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
      expect(provider.status().revision).toBe(1);
    }
    yield* provider.update({
      ...input,
      revision: 1,
      connections: config.connections.map((c) => (c.id === "second" ? { ...c, key: "test-rotated-private" } : c)),
    });
    expect((yield* provider.speech()).key).toBe("test-rotated-private");
    expect(frozen.key).toBe("test-second-private");
    yield* provider.update({ ...input, revision: 2, speech: null });
    expect(yield* provider.speech().pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Binding must not invoke the vendor"))))),
);

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
    expect(endpoints.find((endpoint) => endpoint.op === "provider.voice.list")?.can).toEqual(["owner"]);
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
    expect(JSON.stringify([first, second])).not.toContain("private");
    for (const request of [
      { connection: "first", revision: 0 },
      { connection: "missing", revision: 1 },
      { connection: "first", revision: 1, after: "next-page", offset: 0 },
    ])
      expect(yield* api["provider.voice.list"](request).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
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
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Refused" });
      expect(yield* provider.voices({ connection: "second", revision: 2 }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
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
    expect(JSON.stringify(error)).not.toContain("private");
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
