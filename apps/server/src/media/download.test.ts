import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { PublicHttp } from "#/infra/publicHttp.ts";

import { downloadImage } from "./download.ts";
import { validPng } from "./png.ts";
import { png } from "./testdata/png.ts";

it("PNG validation checks dimensions, CRC, compressed data and complete framing", () => {
  const bytes = png();
  expect(validPng(bytes, 256, 256)).toBe(true);
  expect(validPng(bytes, 512, 256)).toBe(false);
  expect(validPng(bytes.subarray(0, bytes.length - 1), 256, 256)).toBe(false);
  expect(validPng(Buffer.concat([bytes, Buffer.from("trailing")]), 256, 256)).toBe(false);
  bytes[50] = (bytes[50] ?? 0) ^ 1;
  expect(validPng(bytes, 256, 256)).toBe(false);
});

it.effect("downloads send no credentials and return only checked PNG bytes", () => {
  const bytes = png();
  const http = HttpClient.make((request) => {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.method).toBe("GET");
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes, { headers: { "content-type": "image/png" } })));
  });
  return Effect.gen(function* () {
    const downloadImage2 = yield* downloadImage("https://example.com/image.png", 256, 256);
    expect(downloadImage2).toEqual(bytes);
  }).pipe(Effect.provideService(PublicHttp, http));
});

it.effect.each(["https://127.0.0.1/image", "https://[::ffff:7f00:1]/image", "file:///etc/passwd", "http://example.com/image"])(
  "unsafe URL %s is blocked before transport",
  (url) =>
    downloadImage(url, 256, 256).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("DownloadFailed"))),
      Effect.provideService(
        PublicHttp,
        HttpClient.make(() => Effect.die("Unexpected transport")),
      ),
    ),
);
it.effect.each([301, 302, 401, 500])("HTTP %i is not followed or retried", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status, headers: { location: "http://127.0.0.1/secret" } })));
  });
  return Effect.gen(function* () {
    yield* downloadImage("https://example.com/image", 256, 256).pipe(Effect.flip);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(PublicHttp, http));
});
it.effect("a stalled image body is canceled at the download deadline", () =>
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
              { headers: { "content-type": "image/png" } },
            ),
          ),
        ),
      ),
    );
    const fiber = yield* downloadImage("https://example.com/image", 256, 256).pipe(Effect.provideService(PublicHttp, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("60 seconds");
    expect((yield* Fiber.join(fiber))._tag).toBe("DownloadFailed");
    expect(canceled).toBe(true);
  }),
);
