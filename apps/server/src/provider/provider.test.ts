import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { ProviderUpdate } from "@vibevalley/protocol";
import { endpoints } from "@vibevalley/protocol/api";

import { providerHandlers } from "#/http/handlers/provider.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Setting } from "#/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";

import { Provider } from "./provider.ts";

const layer = (http: HttpClient.HttpClient) =>
  Provider.layer.pipe(
    Layer.provideMerge(Setting.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
const configured = (key = "test-first-key"): ProviderUpdate => ({
  revision: 0,
  connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key }],
  dictation: { connection: "moss", model: "moss-transcribe-1.0" },
  image: null,
  understanding: null,
  speech: null,
  live: "moss",
});
it.effect.each(["moss-vl-1.0", "moss-vl-1.0-2026-07-08"])("understanding binding %s is independent, private and frozen per call", (model) =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    expect(yield* Effect.flip(provider.understanding())).toMatchObject({ _tag: "Refused" });
    const vision = { id: "vision", name: "Vision", adapter: "moss", enabled: true, key: "vision-private-key" } as const;
    const config: ProviderUpdate = { ...configured(), connections: [...configured().connections, vision], understanding: { connection: "vision", model } };
    const saved = yield* provider.update(config);
    expect(saved.understanding).toEqual({ connection: "vision", model });
    expect(saved.understandingModels).toEqual(["moss-vl-1.0", "moss-vl-1.0-2026-07-08"]);
    expect(JSON.stringify(saved)).not.toContain("vision-private-key");
    const frozen = yield* provider.understanding();
    expect(frozen).toEqual({ connection: "vision", revision: 1, model, key: "vision-private-key" });
    expect(provider.liveKey()).toBe("test-first-key");
    expect((yield* provider.transcription()).key).toBe("test-first-key");
    if (saved.understanding) saved.understanding.model = "changed-by-caller";
    expect(provider.status().understanding?.model).toBe(model);
    for (const connections of [
      configured().connections,
      [...configured().connections, { ...vision, enabled: false }],
      [...configured().connections, { ...vision, key: null }],
    ]) {
      expect(yield* Effect.flip(provider.update({ ...config, revision: 1, connections }))).toMatchObject({ _tag: "Refused" });
      expect(provider.status().revision).toBe(1);
    }
    yield* provider.update({ ...config, revision: 1, connections: [...configured().connections, { ...vision, key: "rotated-vision-key" }] });
    expect((yield* provider.understanding()).key).toBe("rotated-vision-key");
    expect(frozen.key).toBe("vision-private-key");
    yield* provider.update({ ...config, revision: 2, understanding: null });
    expect(yield* Effect.flip(provider.understanding())).toMatchObject({ _tag: "Refused" });
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Binding must not invoke the vendor"))))),
);

it.effect("cleanup resolves the original connection rather than the current default binding", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const config: ProviderUpdate = {
      ...configured(),
      dictation: null,
      live: null,
      connections: [...configured().connections, { id: "other", name: "Other", adapter: "moss", enabled: true, key: "other-key" }],
      understanding: { connection: "other", model: "moss-vl-1.0" },
    };
    yield* provider.update(config);
    const original = yield* provider.connection("moss");
    expect(original).toEqual({ connection: "moss", revision: 1, key: "test-first-key" });
    expect((yield* provider.understanding()).connection).toBe("other");
    yield* provider.update({
      ...config,
      revision: 1,
      connections: config.connections.map((connection) => (connection.id === "moss" ? { ...connection, enabled: false } : connection)),
    });
    expect(yield* Effect.flip(provider.connection("moss"))).toMatchObject({ _tag: "Refused" });
    expect(yield* Effect.flip(provider.connection("missing"))).toMatchObject({ _tag: "Refused" });
    expect(original.key).toBe("test-first-key");
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Resolving a connection must not invoke a provider"))))),
);

const catalog = { object: "list", data: [{ id: "unknown-model", object: "model", created: 1, owned_by: "MOSS" }] };
const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(catalog))));

it.effect("connections and uses share credentials; replacing and clearing observe revisions", () => {
  const keys: (string | undefined)[] = [];
  const capture = HttpClient.make((request) => {
    keys.push(request.headers.authorization);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(catalog)));
  });
  return Effect.gen(function* () {
    const provider = yield* Provider;
    const setting = yield* Setting;
    const api = yield* providerHandlers;
    expect(yield* api["provider.model.list"]({ connection: "moss", revision: 0 }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
    expect(keys).toEqual([]);
    const saved = yield* api["provider.update"](configured());
    expect(saved.connections[0]?.key).toEqual({ source: "settings", hint: "…-key" });
    expect(JSON.stringify(saved)).not.toContain("test-first-key");
    expect(setting.status()).toMatchObject({ mossReady: true, dictationReady: true });
    expect(provider.liveKey()).toBe("test-first-key");
    expect(yield* provider.transcription()).toEqual({ url: "https://api.mosi.cn/v1", model: "moss-transcribe-1.0", key: "test-first-key" });
    expect(yield* api["provider.model.list"]({ connection: "moss", revision: 1 })).toEqual({
      connection: "moss",
      revision: 1,
      models: [{ id: "unknown-model", owner: "MOSS" }],
    });
    yield* provider.update({ ...configured("test-second-key"), revision: 1 });
    yield* provider.models({ connection: "moss", revision: 2 });
    expect(keys).toEqual(["Bearer test-first-key", "Bearer test-second-key"]);
    const cleared = yield* provider.update({
      revision: 2,
      connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: null }],
      dictation: null,
      image: null,
      understanding: null,
      speech: null,
      live: null,
    });
    expect(cleared.connections[0]?.key).toEqual({ source: null });
    expect(provider.liveKey()).toBe("");
    expect(setting.status()).toMatchObject({ mossReady: false, dictationReady: false });
    expect(yield* provider.models({ connection: "moss", revision: 3 }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
    expect(keys).toHaveLength(2);
    for (const endpoint of endpoints.filter((row) => row.op.startsWith("provider."))) expect(endpoint.can).toEqual(["owner"]);
  }).pipe(Effect.provide(layer(capture)));
});

it.effect("deletion, disabling and clearing require explicit unbinding and unsupported models are refused", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    yield* provider.update(configured());
    const kept = { id: "moss", name: "renamed", adapter: "moss", enabled: true } as const;
    for (const connections of [[], [{ ...kept, enabled: false }], [{ ...kept, key: null }]]) {
      expect(yield* provider.update({ ...configured(), revision: 1, connections }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
      expect(provider.status().revision).toBe(1);
    }
    expect(yield* provider.update({ ...configured(), revision: 1, dictation: { connection: "moss", model: "unknown-model" } }).pipe(Effect.flip)).toMatchObject(
      { _tag: "Refused" },
    );
    yield* provider.update({ ...configured(), revision: 1, connections: [kept] });
    expect(provider.liveKey()).toBe("test-first-key");
    expect(provider.status().connections[0]?.name).toBe("renamed");
    yield* provider.update({ revision: 2, connections: [], dictation: null, image: null, understanding: null, speech: null, live: null });
    expect(provider.status().connections).toEqual([]);
  }).pipe(Effect.provide(layer(http))),
);

it.effect("stale updates cannot overwrite another writer and general settings saves do not lose provider changes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const setting = yield* Setting;
    const results = yield* Effect.all(
      [configured("first-key"), configured("second-key")].map((input) =>
        provider.update(input).pipe(Effect.match({ onSuccess: () => "saved", onFailure: () => "refused" })),
      ),
      { concurrency: 2 },
    );
    expect(results.toSorted()).toEqual(["refused", "saved"]);
    expect(provider.status().revision).toBe(1);
    yield* Effect.all([provider.update({ ...configured("third-key"), revision: 1 }), setting.save({ deepseekApiKey: "test-deepseek" })], { concurrency: 2 });
    expect(provider.liveKey()).toBe("third-key");
    expect(setting.deepseekApiKey()).toBe("test-deepseek");
  }).pipe(Effect.provide(layer(http))),
);

it.effect("discovery rejects an old revision both before and after an in-flight query", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const delayed = HttpClient.make((request) => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(HttpClientResponse.fromWeb(request, Response.json(catalog))),
      );
    });
    yield* Effect.gen(function* () {
      const provider = yield* Provider;
      yield* provider.update(configured());
      expect(yield* provider.models({ connection: "moss", revision: 0 }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
      expect(calls).toBe(0);
      const pending = yield* provider.models({ connection: "moss", revision: 1 }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* provider.update({ ...configured("replacement"), revision: 1 });
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Refused" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(delayed)));
  }),
);

it.effect("each use resolves its own account without key fallback", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    yield* provider.update({
      ...configured("dictation-key"),
      connections: [
        { id: "moss", name: "dictation", adapter: "moss", enabled: true, key: "dictation-key" },
        { id: "live", name: "live", adapter: "moss", enabled: true, key: "live-key" },
      ],
      live: "live",
    });
    expect(provider.liveKey()).toBe("live-key");
    expect((yield* provider.transcription()).key).toBe("dictation-key");
  }).pipe(Effect.provide(layer(http))),
);

it.effect.each(["moss-image-base-1.0", "moss-image-sft-1.0", "moss-image-base-1.0-2026-10-09", "moss-image-sft-1.0-2026-10-09"])(
  "image binding %s saves and resolves without making any network request",
  (model) =>
    Effect.gen(function* () {
      const provider = yield* Provider;
      expect(yield* provider.image().pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
      const saved = yield* provider.update({ ...configured(), image: { connection: "moss", model } });
      expect(saved.image).toEqual({ connection: "moss", model });
      expect(saved.imageModels).toContain(model);
      expect(JSON.stringify(saved)).not.toContain("test-first-key");
      expect(yield* provider.image()).toEqual({ connection: "moss", revision: 1, model, key: "test-first-key" });
      if (saved.image) saved.image.model = "changed-by-caller";
      saved.imageModels.length = 0;
      expect(provider.status().image?.model).toBe(model);
      expect(provider.status().imageModels).toHaveLength(4);
    }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Saving or resolving must not call the provider"))))),
);

it.effect("image references protect their account, allow atomic rebinding, and freeze credentials for a started task", () =>
  Effect.gen(function* () {
    const provider = yield* Provider;
    const first = configured().connections[0];
    if (!first) return yield* Effect.die("Missing test connection");
    const image = { id: "image", name: "Images", adapter: "moss", enabled: true, key: "test-image-key" } as const;
    const config: ProviderUpdate = { ...configured(), connections: [first, image], image: { connection: "image", model: "moss-image-sft-1.0" } };
    yield* provider.update(config);
    const frozen = yield* provider.image();
    expect(frozen.key).toBe("test-image-key");
    expect(provider.liveKey()).toBe("test-first-key");
    expect((yield* provider.transcription()).key).toBe("test-first-key");
    for (const connections of [[first], [first, { ...image, enabled: false }], [first, { ...image, key: null }]]) {
      expect(yield* provider.update({ ...config, revision: 1, connections }).pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
      expect(provider.status().revision).toBe(1);
    }
    yield* provider.update({ ...configured("rotated-key"), revision: 1, image: { connection: "moss", model: "moss-image-sft-1.0-2026-10-09" } });
    expect(yield* provider.image()).toEqual({ connection: "moss", revision: 2, model: "moss-image-sft-1.0-2026-10-09", key: "rotated-key" });
    expect(frozen).toEqual({ connection: "image", revision: 1, model: "moss-image-sft-1.0", key: "test-image-key" });
    yield* provider.update({ ...configured("rotated-key"), revision: 2 });
    expect(yield* provider.image().pipe(Effect.flip)).toMatchObject({ _tag: "Refused" });
    expect(provider.liveKey()).toBe("rotated-key");
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Unexpected network request"))))),
);

it.effect("model discovery distinguishes account errors without returning upstream secrets", () => {
  let status = 401;
  const failed = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("test-private-key", { status }))));
  return Effect.gen(function* () {
    const provider = yield* Provider;
    yield* provider.update(configured("test-private-key"));
    const reasons: string[] = [];
    for (const code of [401, 403, 429, 503]) {
      status = code;
      const error = yield* provider.models({ connection: "moss", revision: 1 }).pipe(Effect.flip);
      expect(error._tag).toBe("Refused");
      expect(JSON.stringify(error)).not.toContain("test-private-key");
      reasons.push(error.reason);
    }
    expect(new Set(reasons).size).toBe(4);
  }).pipe(Effect.provide(layer(failed)));
});
