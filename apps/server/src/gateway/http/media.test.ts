import { createHash } from "node:crypto";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter, Layer, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/http";

import { mediaInputContentPath } from "@vibevalley/protocol";
import { apiSuccessEnvelope } from "@vibevalley/protocol/api";
import { MediaInput } from "@vibevalley/protocol/schema";

import { png } from "#/modules/media/testdata/png.ts";
import { app } from "#/testing/http.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

const decodeMediaInput = (res: HttpClientResponse.HttpClientResponse) =>
  Effect.map(HttpClientResponse.schemaBodyJson(apiSuccessEnvelope(MediaInput))(res), (env) => env.data);

const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(
    app(
      testConfig(),
      0,
      (value) =>
        Effect.sync(() => {
          address = value;
        }),
      quietApp,
    ),
  );
  const client = yield* HttpClient.HttpClient;
  const base = `http://${address}`;
  const post = (op: string, body: unknown) =>
    client.post(`${base}/api/v1/${op.replaceAll(".", "/")}`, { body: HttpBody.text(Formatter.formatJson(body), "application/json") });
  const get = (id: string) => post("media.input.get", { id }).pipe(Effect.flatMap(decodeMediaInput));
  return { base, client, post, get };
});

it.live("raw input upload is user-only, immutable, and separate from JSON attachments", () =>
  Effect.gen(function* () {
    const { base, client, post } = yield* farm;
    const bytes = png();
    const metadata = { kind: "image", mime: "image/png", name: "image.png", size: bytes.length };
    const input = yield* post("media.input.create", metadata).pipe(Effect.flatMap(decodeMediaInput));
    expect(input.phase).toBe("reserved");
    const url = base + mediaInputContentPath(input.id);
    expect((yield* client.put(url, { body: HttpBody.uint8Array(bytes), headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    expect((yield* client.put(url, { body: HttpBody.text("not binary") })).status).toBe(415);
    const ready = yield* client.put(url, { body: HttpBody.uint8Array(bytes) }).pipe(Effect.flatMap(decodeMediaInput));
    expect(ready).toMatchObject({ phase: "ready", canDelete: true, hash: createHash("sha256").update(bytes).digest("hex") });
    expect(ready).not.toHaveProperty("path");
    const downloaded = yield* client.get(url);
    expect(downloaded.status).toBe(200);
    const arrayBuffer2 = yield* downloaded.arrayBuffer;
    expect(Buffer.from(arrayBuffer2)).toEqual(bytes);
    expect((yield* client.get(url, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    const part = yield* client.get(url, { headers: { range: "bytes=4-15" } });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 4-15/${bytes.length}`);
    const arrayBuffer3 = yield* part.arrayBuffer;
    expect(Buffer.from(arrayBuffer3)).toEqual(bytes.subarray(4, 16));
    expect((yield* client.get(url, { headers: { range: `bytes=${bytes.length}-` } })).status).toBe(416);
    expect((yield* client.get(url, { headers: { range: "bytes=0-1,4-5" } })).status).toBe(416);
    expect((yield* post("media.input.delete", { id: input.id })).status).toBe(200);
    expect((yield* post("media.input.get", { id: input.id })).status).toBe(409);
    expect((yield* post("media.input.create", { ...metadata, size: 30_000_001 })).status).toBe(400);
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);

it.live("binary transport accepts a streamed video container larger than the channel attachment limit", () =>
  Effect.gen(function* () {
    const { base, client, post } = yield* farm;
    const size = 26 * 1024 * 1024;
    const first = new Uint8Array(64 * 1024);
    first.set(Buffer.from("000000106674797069736f6d00000000", "hex"));
    const zeros = new Uint8Array(first.length);
    const hash = createHash("sha256");
    const source = Stream.range(0, size / first.length - 1).pipe(
      Stream.map((index) => {
        const chunk = index === 0 ? first : zeros;
        hash.update(chunk);
        return chunk;
      }),
    );
    const input = yield* post("media.input.create", { kind: "video", mime: "video/mp4", name: "transport-fixture.mp4", size }).pipe(
      Effect.flatMap(decodeMediaInput),
    );
    const ready = yield* client
      .put(base + mediaInputContentPath(input.id), { body: HttpBody.stream(source, "application/octet-stream", size) })
      .pipe(Effect.flatMap(decodeMediaInput));
    expect(ready).toMatchObject({ phase: "ready", size, hash: hash.digest("hex") });
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);

it.live("regression: disconnecting a real HTTP upload fails locally and leaves its reservation retryable", () =>
  Effect.gen(function* () {
    const { base, client, post, get } = yield* farm;
    const bytes = png();
    const input = yield* post("media.input.create", { kind: "image", mime: "image/png", name: "input.png", size: bytes.length }).pipe(
      Effect.flatMap(decodeMediaInput),
    );
    const reading = yield* Deferred.make<void>();
    const source = Stream.concat(
      Stream.make(bytes.subarray(0, 32)),
      Stream.fromEffect(Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))),
    );
    const fiber = yield* client
      .put(base + mediaInputContentPath(input.id), { body: HttpBody.stream(source, "application/octet-stream", bytes.length) })
      .pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    yield* waitFor(get(input.id), (row) => row.phase === "uploading", "upload admitted");
    yield* Fiber.interrupt(fiber);
    yield* waitFor(get(input.id), (row) => row.phase === "failed", "disconnected input failed");
    const ready = yield* client.put(base + mediaInputContentPath(input.id), { body: HttpBody.uint8Array(bytes) }).pipe(Effect.flatMap(decodeMediaInput));
    expect(ready.phase).toBe("ready");
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);
