import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { attachmentMax, type MediaAudioFormat } from "@vibevalley/protocol";

import { Attachment } from "#/attachment/attachment.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { world } from "#/testing/world.ts";

import { saveAudioResult } from "./audioResult.ts";
import { audioResultMax } from "./input.ts";
import { makeInputs } from "./inputs.ts";
import { mp3, wav } from "./testdata/audio.ts";

const answer = (bytes: Buffer, type: string, headers: Record<string, string> = {}) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes, { headers: { "content-type": type, ...headers } }))));

const downloadSpeech = Effect.fnUntraced(function* (url: string, format: MediaAudioFormat) {
  const http = yield* PublicHttp;
  return yield* Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const result = yield* saveAudioResult("download-test", url, format, inputs).pipe(Effect.provideService(PublicHttp, http));
    expect(result.resultInput).toBeNull();
    if (!result.attachment) return yield* Effect.die("Expected a small attachment");
    const attachment = yield* (yield* Attachment).get(result.attachment.id);
    if (!attachment) return yield* Effect.die("Missing saved attachment");
    const file = yield* (yield* FileSystem.FileSystem).readFile(attachment.path);
    return Buffer.from(file);
  }).pipe(Effect.scoped, Effect.provide(world()));
});

it.effect.each(["wav", "mp3"] as const)("downloads complete %s audio without credentials", (format) => {
  const bytes = format === "wav" ? wav() : mp3;
  const type = format === "wav" ? "audio/wav" : "audio/mpeg";
  const http = HttpClient.make((request) => {
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes, { headers: { "content-type": type } })));
  });
  return Effect.gen(function* () {
    const downloadSpeech2 = yield* downloadSpeech(`https://audio.example.com/result.${format}?token=private`, format);
    expect(downloadSpeech2).toEqual(bytes);
  }).pipe(Effect.provideService(PublicHttp, http));
});

it.effect.each([
  "https://127.0.0.1/audio",
  "https://10.0.0.1/audio",
  "https://[::ffff:7f00:1]/audio",
  "https://user:password@example.com/audio",
  "https://example.com:444/audio",
  "http://example.com/audio",
  "file:///etc/passwd",
])("unsafe speech URL %s never reaches transport", (address) =>
  Effect.gen(function* () {
    const downloadSpeechFailure = yield* downloadSpeech(address, "wav").pipe(Effect.flip);
    expect(downloadSpeechFailure).toMatchObject({ _tag: "Refused" });
  }).pipe(
    Effect.provideService(
      PublicHttp,
      HttpClient.make(() => Effect.die("Unsafe audio URL reached transport")),
    ),
  ),
);

it.effect.each([301, 302, 401, 404, 503])("HTTP %i neither follows redirects nor retries speech downloads", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status, headers: { location: "https://127.0.0.1/private" } })));
  });
  return Effect.gen(function* () {
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(Effect.flip);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(PublicHttp, http));
});

it.effect("regression: WAV framing, sample alignment and the declared codec must agree", () => {
  const original = wav();
  const badRate = Buffer.from(original);
  badRate.writeUInt32LE(1, 28);
  const badCodec = Buffer.from(original);
  badCodec.writeUInt16LE(7, 20);
  const badBlock = Buffer.from(original);
  badBlock.writeUInt16LE(3, 32);
  const partialSample = Buffer.from(original.subarray(0, original.length - 1));
  partialSample.writeUInt32LE(partialSample.length - 8, 4);
  partialSample.writeUInt32LE(partialSample.length - 44, 40);
  return Effect.forEach(
    [
      original.subarray(0, 43),
      original.subarray(0, original.length - 1),
      Buffer.concat([original, Buffer.from("trailing")]),
      badRate,
      badCodec,
      badBlock,
      partialSample,
    ],
    (bytes) => downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(bytes, "audio/wav"))),
    { discard: true },
  );
});

it.effect("regression: WAV chunk padding and extensible PCM are validated", () => {
  const original = wav();
  const extensible = Buffer.concat([original.subarray(0, 36), Buffer.alloc(24), original.subarray(36)]);
  extensible.writeUInt32LE(extensible.length - 8, 4);
  extensible.writeUInt32LE(40, 16);
  extensible.writeUInt16LE(0xfffe, 20);
  extensible.writeUInt16LE(22, 36);
  extensible.writeUInt16LE(16, 38);
  extensible.writeUInt32LE(4, 40);
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(extensible, 44);
  const padded = Buffer.concat([original.subarray(0, 36), Buffer.from("4a554e4b010000000000", "hex"), original.subarray(36)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  return Effect.gen(function* () {
    const downloadSpeech2 = yield* downloadSpeech("https://audio.example.com/pcm.wav", "wav").pipe(
      Effect.provideService(PublicHttp, answer(extensible, "audio/x-wav")),
    );
    expect(downloadSpeech2).toEqual(extensible);
    const downloadSpeech3 = yield* downloadSpeech("https://audio.example.com/padded.wav", "wav").pipe(
      Effect.provideService(PublicHttp, answer(padded, "audio/wave")),
    );
    expect(downloadSpeech3).toEqual(padded);
    extensible[59] = 0;
    yield* downloadSpeech("https://audio.example.com/bad.wav", "wav").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(extensible, "audio/wav")));
  });
});

it.effect("regression: MP3 frames and metadata must be complete rather than just start with a signature", () => {
  const invalidHeader = Buffer.from(mp3);
  invalidHeader[2] = 0;
  const tagged = Buffer.concat([Buffer.from("49443304000000000000", "hex"), mp3, Buffer.from("TAG"), Buffer.alloc(125)]);
  const invalidTag = Buffer.from(tagged);
  invalidTag[6] = 128;
  return Effect.gen(function* () {
    const downloadSpeech2 = yield* downloadSpeech("https://audio.example.com/tagged.mp3", "mp3").pipe(
      Effect.provideService(PublicHttp, answer(tagged, "audio/mp3")),
    );
    expect(downloadSpeech2).toEqual(tagged);
    yield* Effect.forEach(
      [mp3.subarray(0, 4), mp3.subarray(0, mp3.length - 1), Buffer.concat([mp3, Buffer.from("trailing")]), invalidHeader, invalidTag, tagged.subarray(0, 10)],
      (bytes) => downloadSpeech("https://audio.example.com/bad.mp3", "mp3").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(bytes, "audio/mpeg"))),
      { discard: true },
    );
  });
});

it.effect("regression: format, MIME, declared length and actual audio must match", () =>
  Effect.gen(function* () {
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(mp3, "audio/wav")));
    yield* downloadSpeech("https://audio.example.com/result.mp3", "mp3").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(wav(), "audio/mpeg")));
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(Effect.flip, Effect.provideService(PublicHttp, answer(wav(), "text/html")));
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(
      Effect.flip,
      Effect.provideService(PublicHttp, answer(wav(), "audio/wav", { "content-length": "44" })),
    );
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(
      Effect.flip,
      Effect.provideService(PublicHttp, answer(wav(), "audio/wav", { "content-length": String(audioResultMax + 1) })),
    );
    yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(
      Effect.flip,
      Effect.provideService(PublicHttp, answer(Buffer.alloc(attachmentMax + 1), "audio/wav")),
    );
  }),
);

it.effect("a stalled speech body is canceled at the download deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    // The body's cancel comes after the download has given up, on the stream's own turn.
    const canceled = yield* Deferred.make<void>();
    const http = HttpClient.make((request) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  Deferred.doneUnsafe(canceled, Exit.void);
                },
              }),
              { headers: { "content-type": "audio/wav" } },
            ),
          ),
        ),
      ),
    );
    const fiber = yield* downloadSpeech("https://audio.example.com/result.wav", "wav").pipe(
      Effect.provideService(PublicHttp, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    expect((yield* Fiber.join(fiber))._tag).toBe("Refused");
    yield* Deferred.await(canceled);
  }),
);
