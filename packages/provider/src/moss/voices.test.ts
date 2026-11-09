import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { createMossVoice, listMossVoices } from "./voices.ts";

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

const clone = { audio: new Blob(["synthetic-sample"], { type: "audio/wav" }), filename: "sample.wav", durationSeconds: 2 };

it.effect.each([undefined, "", "Narrator"])("voice cloning uploads an explicit Blob and preserves name %#", (name) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/voices");
      expect(request.headers.authorization).toBe("Bearer clone-account");
      expect(request.headers["content-type"]).toBeUndefined();
      if (request.body._tag !== "FormData") return yield* Effect.die("Expected multipart Blob upload");
      expect(Array.from(request.body.formData.keys())).toEqual(name === undefined ? ["audio_sample"] : ["audio_sample", "name"]);
      expect(request.body.formData.get("name")).toBe(name ?? null);
      const sample = request.body.formData.get("audio_sample");
      expect(sample).toBeInstanceOf(Blob);
      if (!(sample instanceof Blob)) return yield* Effect.die("Expected audio Blob");
      expect(sample.size).toBe(clone.audio.size);
      expect(sample.type).toBe("audio/wav");
      return HttpClientResponse.fromWeb(request, Response.json({ ...voice, name: name ?? "" }));
    }),
  );
  return Effect.gen(function* () {
    expect(yield* createMossVoice("clone-account", { ...clone, ...(name !== undefined ? { name } : {}) })).toEqual({
      id: voice.id,
      name: name ?? "",
      createdAtSeconds: 1,
    });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  { audio: new Blob([], { type: "audio/wav" }) },
  { audio: new Blob([new Uint8Array(10_000_001)], { type: "audio/wav" }) },
  { audio: new Blob(["sample"], { type: "audio/opus" }), filename: "sample.opus" },
  { audio: "base64" },
  { filename: "../sample.wav" },
  { filename: "sample.mp4" },
  { durationSeconds: 0 },
  { durationSeconds: 30.01 },
  { durationSeconds: Infinity },
  { name: "x".repeat(1001) },
  { url: "https://example.com/sample.wav" },
  { file_id: "file-one" },
])("invalid clone input %# cannot upload or create a voice", (patch) =>
  Effect.gen(function* () {
    expect(yield* createMossVoice("clone-account", { ...clone, ...patch }).pipe(Effect.flip)).toMatchObject({
      reason: "InvalidInput",
      outcome: "NotSubmitted",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not upload")),
    ),
  ),
);

it.effect.each([{ ...voice, object: "file" }, { ...voice, id: "../voice" }, { ...voice, created_at: -1 }, { task_id: "task-one" }])(
  "invalid clone receipt %# does not invent a reusable voice",
  (body) =>
    Effect.gen(function* () {
      expect(yield* createMossVoice("clone-account", clone).pipe(Effect.flip)).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("a lost clone response is unknown and never retried", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    const fiber = yield* createMossVoice("clone-account", clone).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(calls).toBe(1);
  }),
);
