import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { mossModels } from "./models.ts";

const model = (id: string) => ({ id, object: "model", created: 1767225600, owned_by: "MOSS" });
const catalog = (ids: string[]) => Formatter.formatJson({ object: "list", data: ids.map(model) });
const answer = (body: string, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))));

it.effect("MOSS lists account models with explicit authentication and no redirect or capability inference", () => {
  const sent: { url: string; key: string | null; method: string | undefined; redirect: string | undefined }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      key: new Headers(init?.headers).get("authorization"),
      method: init?.method,
      redirect: init?.redirect,
    });
    return Promise.resolve(new Response(catalog(["moss-transcribe-1.0", "unknown-future-model"])));
  };
  return Effect.gen(function* () {
    const mossModels2 = yield* mossModels("test-key");
    expect(mossModels2).toEqual([
      { id: "moss-transcribe-1.0", owner: "MOSS" },
      { id: "unknown-future-model", owner: "MOSS" },
    ]);
    expect(sent).toEqual([{ url: "https://api.mosi.cn/v1/models", key: "Bearer test-key", method: "GET", redirect: "manual" }]);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect("MOSS rejects empty or malformed credentials before touching the network", () => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.die("Unexpected network request");
  });
  return Effect.gen(function* () {
    for (const key of ["", " ", "invalid key", "key\nheader"]) {
      const failure = yield* mossModels(key).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "Credentials" });
    }
    expect(calls).toBe(0);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([301, 401, 403, 429, 500, 503])("MOSS reports HTTP %i once without exposing its response body", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("echoed-secret", { status })));
  });
  return Effect.gen(function* () {
    const error = yield* mossModels("test-key").pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status });
    expect(Formatter.formatJson(error)).not.toContain("echoed-secret");
    expect(Formatter.formatJson(error)).not.toContain("test-key");
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each(["not json", "{}", '{"object":"list","data":[{"id":"only-an-id"}]}', catalog([""])])(
  "MOSS rejects malformed catalogs %# without leaking the body",
  (body) =>
    Effect.gen(function* () {
      const mossModelsFailure = yield* mossModels("test-key").pipe(Effect.flip);
      expect(mossModelsFailure).toMatchObject({ reason: "InvalidResponse" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("MOSS accepts an empty account catalog", () =>
  Effect.gen(function* () {
    const mossModels2 = yield* mossModels("test-key");
    expect(mossModels2).toEqual([]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(catalog([])))),
);

it.effect.each([" ".repeat((1 << 20) + 1), catalog(Array.from({ length: 1001 }, (_, i) => `model-${i}`))])(
  "MOSS refuses oversized catalogs instead of returning a truncated list %#",
  (body) =>
    Effect.gen(function* () {
      const mossModelsFailure = yield* mossModels("test-key").pipe(Effect.flip);
      expect(mossModelsFailure).toMatchObject({ reason: "TooLarge" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("MOSS query timeout interrupts the transport without retrying", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      );
    });
    const fiber = yield* mossModels("test-key").pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout" });
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("MOSS query timeout also bounds reading the response body", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let canceled = false;
    const http = HttpClient.make((request) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  canceled = true;
                },
              }),
            ),
          ),
        ),
      ),
    );
    const fiber = yield* mossModels("test-key").pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout" });
    expect(canceled).toBe(true);
  }),
);

it.effect("MOSS transport failures do not expose request credentials", () => {
  const fetcher: typeof fetch = () => Promise.reject(new Error("test-secret-in-network-error"));
  return Effect.gen(function* () {
    const error = yield* mossModels("test-key").pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "Network" });
    expect(Formatter.formatJson(error)).not.toContain("test-secret-in-network-error");
    expect(Formatter.formatJson(error)).not.toContain("test-key");
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect("canceling MOSS discovery interrupts the in-flight transport", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    );
    const fiber = yield* mossModels("test-key").pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
  }),
);
