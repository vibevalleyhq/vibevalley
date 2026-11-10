import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { deleteMossFile, getMossFile, listMossFiles, uploadMossFile } from "./files.ts";
import { understandMossMedia } from "./understanding.ts";

const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const file = { id: "file-test", object: "file", bytes: 3, created_at: 42, filename: "image.png", purpose: "image", status: "processed" };
const input = { file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), filename: "image.png", purpose: "image" };
const answer = (value: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value, { status }))));

it.effect("file upload keeps a Blob multipart body and the client owns its boundary", () => {
  const sent: RequestInit[] = [];
  const fetcher: typeof fetch = (url, init) => {
    expect(url instanceof Request ? url.url : String(url)).toBe("https://api.mosi.cn/v1/files");
    if (init !== undefined) sent.push(init);
    return Promise.resolve(Response.json(file));
  };
  return Effect.gen(function* () {
    const mossFileUploaded = yield* uploadMossFile("test-key", input);
    expect(mossFileUploaded).toEqual(file);
    expect(sent).toHaveLength(1);
    const init = sent[0];
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("Expected a streaming multipart form");
    expect(body.get("purpose")).toBe("image");
    const uploaded = body.get("file");
    if (!(uploaded instanceof Blob)) throw new Error("Expected a Blob");
    expect(uploaded.size).toBe(3);
    expect(uploaded.type).toBe("image/png");
    const encoded = yield* Effect.promise(() => new Response(body).text());
    expect(encoded).toContain('name="file"; filename="image.png"');
    expect(encoded).toContain('name="purpose"\r\n\r\nimage');
    expect(encoded).toContain(String.fromCharCode(1, 2, 3));
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect.each([
  { file: "base64" },
  { file: new Blob([]) },
  { purpose: "other" },
  { filename: "" },
  { filename: "../secret" },
  { filename: "a\r\nb" },
  { filename: "a\\b" },
  { filename: "x".repeat(257) },
  { path: "/private/image" },
])("invalid upload never reaches the transport %#", (invalid) =>
  Effect.gen(function* () {
    const mossFileUploadedFailure = yield* Effect.flip(uploadMossFile("test-key", { ...input, ...invalid }));
    expect(mossFileUploadedFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not send")),
    ),
  ),
);

it.effect.each([
  "",
  ".",
  "..",
  "../secret",
  "a/b",
  "a\\b",
  "a?key=value",
  "a#part",
  "key\n",
  "x".repeat(257),
  String.fromCharCode(0xd800),
  `file${String.fromCharCode(0)}`,
])("file IDs cannot escape the fixed endpoint %#", (id) =>
  Effect.gen(function* () {
    const mossFileFailure = yield* Effect.flip(getMossFile("test-key", id));
    expect(mossFileFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
    const mossFileDeletedFailure = yield* Effect.flip(deleteMossFile("test-key", id));
    expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not send")),
    ),
  ),
);

it.effect("lookup and deletion require receipts for the requested file", () =>
  Effect.gen(function* () {
    const mossFile = yield* getMossFile("test-key", "file-test").pipe(Effect.provideService(HttpClient.HttpClient, answer(file)));
    expect(mossFile).toEqual(file);
    const mossFileDeleted = yield* deleteMossFile("test-key", "file-test").pipe(
      Effect.provideService(HttpClient.HttpClient, answer({ id: "file-test", object: "file", deleted: true })),
    );
    expect(mossFileDeleted).toEqual({ id: "file-test", object: "file", deleted: true });
    const mossFileFailure = yield* Effect.flip(getMossFile("test-key", "file-other").pipe(Effect.provideService(HttpClient.HttpClient, answer(file))));
    expect(mossFileFailure).toMatchObject({
      reason: "InvalidResponse",
      outcome: "Unknown",
    });
    const mossFileDeletedFailure = yield* Effect.flip(
      deleteMossFile("test-key", "file-other").pipe(Effect.provideService(HttpClient.HttpClient, answer({ id: "file-test", object: "file", deleted: true }))),
    );
    expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }),
);

it.effect.each([{ bytes: 4 }, { purpose: "video" }])("upload receipts must match the submitted bytes and purpose %#", (change) =>
  Effect.gen(function* () {
    const mossFileUploadedFailure = yield* Effect.flip(uploadMossFile("test-key", input));
    expect(mossFileUploadedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...file, ...change }))),
);

it.effect.each([{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 100001 }, { limit: 1.5 }, { cursor: "arbitrary" }])(
  "invalid pagination does not query %#",
  (page) =>
    Effect.gen(function* () {
      const mossFilesFailure = yield* Effect.flip(listMossFiles("test-key", page));
      expect(mossFilesFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not send")),
      ),
    ),
);

it.effect("list preserves empty purpose and unfamiliar file status rather than assuming readiness", () =>
  Effect.gen(function* () {
    const listed = yield* listMossFiles("test-key", { limit: 1, offset: 0 });
    expect(listed).toEqual([{ ...file, purpose: "", status: "new-status" }]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ object: "list", data: [{ ...file, purpose: "", status: "new-status" }] }))),
);

it.effect.each([400, 401, 403, 413, 429, 302, 404, 500])("file HTTP %s is sanitized and not retried", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ key: "test-key", url: "private-url" }, { status })));
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(uploadMossFile("test-key", input));
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 429].includes(status) ? "Rejected" : "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/test-key|private-url/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("regression: files larger than the vendor upload limit are rejected without reading bytes", () => {
  class Oversized extends Blob {
    override get size() {
      return 512_000_001;
    }
  }
  return Effect.gen(function* () {
    const mossFileUploadedFailure = yield* Effect.flip(uploadMossFile("test-key", { ...input, file: new Oversized() }));
    expect(mossFileUploadedFailure).toMatchObject({
      reason: "InvalidInput",
      outcome: "NotSubmitted",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not send")),
    ),
  );
});

it.effect.each(["", " ", "key\nheader"])("file credentials are explicit and validated %#", (key) =>
  Effect.gen(function* () {
    const mossFileUploadedFailure = yield* Effect.flip(uploadMossFile(key, input));
    expect(mossFileUploadedFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not send")),
    ),
  ),
);

it.effect("file metadata and list responses are bounded", () =>
  Effect.gen(function* () {
    const mossFileFailure = yield* Effect.flip(
      getMossFile("test-key", "file-test").pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...file, filename: "x".repeat(1 << 20) }))),
    );
    expect(mossFileFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
    const mossFilesFailure = yield* Effect.flip(
      listMossFiles("test-key", { limit: 1 }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ object: "list", data: [file, file] }))),
    );
    expect(mossFilesFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    const mossFileDeletedFailure = yield* Effect.flip(
      deleteMossFile("test-key", "file-test").pipe(Effect.provideService(HttpClient.HttpClient, answer({ id: "file-test", object: "file", deleted: false }))),
    );
    expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }),
);

it.effect("canceling an upload interrupts only that transport and never resubmits", () =>
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
    const fiber = yield* uploadMossFile("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("an uploaded file can be referenced for understanding and explicitly deleted with the same account", () => {
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe("Bearer test-key");
    if (request.url.endsWith("/responses")) {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
      expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toEqual({
        model: "moss-vl-1.0",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Describe the image" },
              { type: "input_image", file_id: "file-test" },
            ],
          },
        ],
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "response-id",
            model: "moss-vl-1.0",
            status: "completed",
            output: [{ content: [{ type: "output_text", text: "A farm" }] }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          }),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(request.method === "DELETE" ? { id: file.id, object: "file", deleted: true } : file)),
    );
  });
  return Effect.gen(function* () {
    const uploaded = yield* uploadMossFile("test-key", input);
    expect((yield* getMossFile("test-key", uploaded.id)).status).toBe("processed");
    const result = yield* understandMossMedia("test-key", {
      model: "moss-vl-1.0",
      text: "Describe the image",
      media: [{ kind: "image", fileId: uploaded.id }],
    });
    expect(result.text).toBe("A farm");
    expect((yield* deleteMossFile("test-key", uploaded.id)).deleted).toBe(true);
    expect(calls).toEqual([
      "POST https://api.mosi.cn/v1/files",
      "GET https://api.mosi.cn/v1/files/file-test",
      "POST https://api.mosi.cn/v1/responses",
      "DELETE https://api.mosi.cn/v1/files/file-test",
    ]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("file request deadline includes response reading and cancels the stream", () =>
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
    const fiber = yield* uploadMossFile("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(canceled).toBe(true);
  }),
);
