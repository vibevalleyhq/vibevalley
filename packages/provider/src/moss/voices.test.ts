import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { listMossVoices } from "./voices.ts";

const voice = { id: "voice-one", object: "audio.voice", name: "", created_at: 1 };
const page = { object: "list", data: [voice], first_id: voice.id, last_id: voice.id, has_more: true, next_cursor: "offset:20/+=" };
const answer = (body: unknown) => HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))));

it.effect("voice pagination preserves names and opaque cursors without guessing readiness or fetching another page", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/voices");
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(request.urlParams.params).toEqual([
      ["limit", "2"],
      ["after", page.next_cursor],
      ["status", "future-state"],
    ]);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(page)));
  });
  return Effect.gen(function* () {
    expect(yield* listMossVoices("test-key", { limit: 2, after: page.next_cursor, status: "future-state" })).toEqual({
      voices: [{ id: voice.id, name: "", createdAtSeconds: 1 }],
      hasMore: true,
      nextCursor: page.next_cursor,
    });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("empty lists and an explicit zero offset are valid", () => {
  const http = HttpClient.make((request) => {
    expect(request.urlParams.params).toEqual([
      ["limit", "20"],
      ["offset", "0"],
    ]);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ object: "list", data: [], has_more: false })));
  });
  return Effect.gen(function* () {
    expect(yield* listMossVoices("test-key", { offset: 0 })).toEqual({ voices: [], hasMore: false, nextCursor: null });
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  { limit: 0 },
  { limit: 151 },
  { limit: 1.5 },
  { offset: -1 },
  { offset: 100001 },
  { after: "" },
  { after: "x".repeat(8193) },
  { status: "" },
  { offset: 0, after: "next" },
  { url: "https://example.com" },
])("invalid listing input %# never reaches the network", (input) =>
  Effect.gen(function* () {
    expect(yield* listMossVoices("test-key", input).pipe(Effect.flip)).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not request")),
    ),
  ),
);

it.effect.each([
  { ...page, next_cursor: null },
  { ...page, first_id: "wrong" },
  { ...page, last_id: "wrong" },
  { ...page, data: [voice, voice] },
  { ...page, data: [{ ...voice, created_at: -1 }] },
  { ...page, data: [{ ...voice, object: "file" }] },
  { ...page, data: Array.from({ length: 151 }, (_, n) => ({ ...voice, id: `voice-${n}` })) },
])("invalid voice listing %# is not exposed as usable choices", (body) =>
  Effect.gen(function* () {
    expect(yield* listMossVoices("test-key", {}).pipe(Effect.flip)).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("voice lists have a byte bound independent of their item bound", () =>
  Effect.gen(function* () {
    expect(yield* listMossVoices("test-key", {}).pipe(Effect.flip)).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...page, privatePadding: "x".repeat(1 << 20) }))),
);

it.effect.each(["timeout", "cancel"])("%s stops a pending voice query without retry", (action) =>
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
    const fiber = yield* listMossVoices("test-key", {}).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else {
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout" });
    }
    expect(yield* Deferred.isDone(stopped)).toBe(true);
    expect(calls).toBe(1);
  }),
);
