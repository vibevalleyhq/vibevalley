import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { submitMossAudioTask } from "./audio-submission.ts";

const endpoints = ["speech/speakers", "voice/generations", "transcriptions"] as const;
const answer = (body: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))));

it.effect.each(endpoints)("%s never retries ambiguous billable submissions or exposes vendor diagnostics", (endpoint) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ error: { code: "secret-account", message: "private-key signed-url" } }, { status: 503 })),
    );
  });
  return Effect.gen(function* () {
    const error = yield* submitMossAudioTask("test-key", endpoint, {}).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status: 503, outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/secret-account|private-key|signed-url/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  {},
  { task_id: "../task" },
  { task_id: "task", retry_after: -1 },
  { task_id: "task", retry_after: 1.5 },
  { task_id: "task", retry_after: "5" },
])("invalid submission receipt %# remains unknown, not rejected", (body) =>
  Effect.gen(function* () {
    const mossAudioTaskSubmittedFailure = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect.each(["", " ", "private\nheader"])("invalid credentials %# do not submit", (key) =>
  Effect.gen(function* () {
    const mossAudioTaskSubmittedFailure = yield* submitMossAudioTask(key, "voice/generations", {}).pipe(Effect.flip);
    expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect("oversized submission receipts are bounded independently of task metadata", () =>
  Effect.gen(function* () {
    const mossAudioTaskSubmittedFailure = yield* submitMossAudioTask("test-key", "speech/speakers", {}).pipe(Effect.flip);
    expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ task_id: "task", padding: "x".repeat(1 << 20) }))),
);

it.effect.each([301, 302, 303, 307, 308])("regression: bodyless HTTP %i stays unknown and is never followed", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      const serviceOption2 = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      expect(serviceOption2).toMatchObject({ _tag: "Some", value: { redirect: "manual" } });
      return HttpClientResponse.fromWeb(request, new Response(null, { status, headers: { location: "https://private.example.com/signed-url" } }));
    }),
  );
  return Effect.gen(function* () {
    const error = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/private|signed-url/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([400, 401, 403, 413, 422, 429, 503])("regression: bodyless HTTP %i preserves submission status", (status) =>
  Effect.gen(function* () {
    const mossAudioTaskSubmittedFailure = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(mossAudioTaskSubmittedFailure).toMatchObject({
      reason: "HttpStatus",
      status,
      outcome: status === 503 ? "Unknown" : "Rejected",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })))),
    ),
  ),
);

it.effect.each([200, 204])("regression: empty HTTP %i is not a valid submission receipt", (status) =>
  Effect.gen(function* () {
    const mossAudioTaskSubmittedFailure = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(mossAudioTaskSubmittedFailure).toMatchObject({
      reason: "InvalidResponse",
      outcome: "Unknown",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })))),
    ),
  ),
);

it.effect("regression: transport errors are not mistaken for empty receipts", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: new Error("private-key signed-url") }),
      }),
    );
  });
  return Effect.gen(function* () {
    const error = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/private-key|signed-url/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("regression: interrupted receipt bodies stay network failures with unknown outcomes", () => {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("private-body-error"));
            },
          }),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const error = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toContain("private-body-error");
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each(["timeout", "cancel"])("%s interrupts an outstanding submission without retry or remote-cancel claims", (action) =>
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
    const fiber = yield* submitMossAudioTask("test-key", "voice/generations", {}).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else {
      yield* TestClock.adjust("300 seconds");
      const fiber2 = yield* Fiber.join(fiber);
      expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    }
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("submission deadline includes a response body that never completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const http = HttpClient.make((request) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"task_id":"task"'));
                },
              }),
            ),
          ),
        ),
      ),
    );
    const fiber = yield* submitMossAudioTask("test-key", "transcriptions", {}).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  }),
);
