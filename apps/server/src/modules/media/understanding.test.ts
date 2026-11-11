import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { MediaUnderstandingRequest } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { png } from "#/modules/media/testdata/png.ts";
import { Provider } from "#/modules/provider/provider.ts";
import { waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/media_job.sql.ts";

import { makeInputs } from "./inputs.ts";
import { newJob } from "./job.ts";
import { Media } from "./media.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });
const parsed = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const bytes = png();
const result = {
  id: "response-one",
  model: "moss-vl-1.0-2026-07-08",
  status: "completed",
  output: [{ content: [{ type: "output_text", text: "A synthetic green square." }] }],
  usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
};
const reply = (request: HttpClientRequest.HttpClientRequest, response = result) => {
  if (request.method === "DELETE") return HttpClientResponse.fromWeb(request, Response.json({ id: "file-one", object: "file", deleted: true }));
  if (request.url.endsWith("/files"))
    return HttpClientResponse.fromWeb(
      request,
      Response.json({ id: "file-one", object: "file", bytes: bytes.length, created_at: 1, filename: "accepted.png", purpose: "image", status: "processed" }),
    );
  return HttpClientResponse.fromWeb(request, Response.json(response));
};
const layer = (http: HttpClient.HttpClient) =>
  Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(Layer.fresh(Provider.layer)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(world()),
  );
const fixture = Effect.gen(function* () {
  const status = yield* (yield* Provider).update({
    revision: 0,
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-only-understanding-key" }],
    image: { connection: "moss", model: "moss-image-sft-1.0" },
    understanding: { connection: "moss", model: "moss-vl-1.0" },
    speech: null,
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });
  const media = yield* Media;
  const input = yield* media.inputs.create({ kind: "image", mime: "image/png", name: "private-user-image.png", size: bytes.length });
  yield* media.inputs.upload(input.id, Stream.make(bytes));
  const request: MediaUnderstandingRequest = {
    id: "understanding-one",
    prompt: "Describe this synthetic image.",
    inputs: [input.id],
    connection: "moss",
    revision: status.revision,
    allowUpload: true,
    maxOutputTokens: 64,
  };
  return { media, input, request };
});

it.effect.each(["completed", "incomplete"])("understanding persists %s text and actual usage, projects it, cleans files, and deduplicates", (status) => {
  const calls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe("Bearer test-only-understanding-key");
      if (request.url.endsWith("/files")) {
        if (request.body._tag !== "FormData") return yield* Effect.die("Expected multipart");
        const file = request.body.formData.get("file");
        if (!(file instanceof File)) return yield* Effect.die("Expected file");
        expect(file.name).not.toContain("private-user");
        const arrayBuffer2 = yield* Effect.promise(() => file.arrayBuffer());
        expect(Buffer.from(arrayBuffer2)).toEqual(bytes);
      }
      if (request.url.endsWith("/responses")) {
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
        const body = yield* Effect.option(parsed(new TextDecoder().decode(request.body.body)));
        expect(body).toEqual(
          Option.some({
            model: "moss-vl-1.0",
            max_output_tokens: 64,
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "Describe this synthetic image." },
                  { type: "input_image", file_id: "file-one" },
                ],
              },
            ],
          }),
        );
      }
      return reply(request, { ...result, status });
    }),
  );
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    expect((yield* media.createUnderstanding(request)).phase).toBe("queued");
    const job = yield* waitFor(media.get(request.id), (row) => row.kind === "understanding" && row.cleanup === "done", "understanding and cleanup complete");
    if (job.kind !== "understanding") return yield* Effect.die("Expected understanding");
    expect(job.phase).toBe(status === "completed" ? "ready" : "incomplete");
    expect(job.result).toEqual({
      model: result.model,
      text: result.output[0]?.content[0]?.text,
      status,
      incompleteReason: null,
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
    });
    expect(job.inputs[0]).toMatchObject({ id: input.id, name: input.name });
    expect((yield* Core).state().media).toEqual([job]);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
    const understandingCreated = yield* media.createUnderstanding(request);
    expect(understandingCreated).toEqual(job);
    const cleanupUnderstanding2 = yield* media.cleanupUnderstanding(request.id);
    expect(cleanupUnderstanding2).toEqual(job);
    expect(calls).toEqual(["POST https://api.mosi.cn/v1/files", "POST https://api.mosi.cn/v1/responses", "DELETE https://api.mosi.cn/v1/files/file-one"]);
    yield* notIn(job, "test-only-understanding-key");
    const found = yield* (yield* Db).one(q.mediaJob({ id: request.id }));
    yield* notIn(found, "test-only-understanding-key");
    const understandingCreatedFailure = yield* media.createUnderstanding({ ...request, prompt: "Different question" }).pipe(Effect.flip);
    expect(understandingCreatedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: stale consent and an image task ID cannot submit an understanding request", () => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.never;
  });
  return Effect.gen(function* () {
    const { media, request } = yield* fixture;
    const understandingCreatedFailure = yield* media.createUnderstanding({ ...request, revision: 0 }).pipe(Effect.flip);
    expect(understandingCreatedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect(calls).toBe(0);
    yield* media.createImage({ id: request.id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true }, { kind: "user" });
    const understandingCreatedFailure2 = yield* media.createUnderstanding(request).pipe(Effect.flip);
    expect(understandingCreatedFailure2).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    yield* media.cancel(request.id);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: shared history uses the same binary ID order as SQLite for tied timestamps", () =>
  Effect.gen(function* () {
    const { media, request } = yield* fixture;
    const image = yield* media.createImage(
      { id: "a-image", prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true },
      { kind: "user" },
    );
    const understanding = yield* media.createUnderstanding({ ...request, id: "Z-understanding" });
    expect(image.createdAt).toBe(understanding.createdAt);
    expect((yield* media.list()).map((job) => job.id)).toEqual(["Z-understanding", "a-image"]);
    yield* media.cancel(understanding.id);
    yield* media.cancel(image.id);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.never)))),
);

it.effect("invalid input references, mixed media and bounds fail before retention or vendor calls", () => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.die("Invalid input must not contact the provider");
  });
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    const header = Buffer.alloc(32);
    header.write("ftyp", 4);
    const video = yield* media.inputs.create({ kind: "video", name: "container-header.mp4", mime: "video/mp4", size: header.length });
    yield* media.inputs.upload(video.id, Stream.make(header));
    yield* Effect.forEach(
      [
        { ...request, inputs: ["/etc/passwd"] },
        { ...request, inputs: [input.id, input.id] },
        { ...request, inputs: [input.id, video.id] },
        { ...request, maxOutputTokens: 0 },
        { ...request, inputs: Array.from({ length: 6 }, (_, n) => `input-${n}`) },
      ],
      (invalid) =>
        media.createUnderstanding(invalid).pipe(
          Effect.flip,
          Effect.map((error) => expect(error).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused })),
        ),
      { discard: true },
    );
    expect(calls).toBe(0);
    const medias = yield* media.list();
    expect(medias).toEqual([]);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
    expect((yield* media.inputs.get(video.id)).canDelete).toBe(true);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("unknown inference is not repeated and retains files until explicit cleanup", () => {
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(request.url);
    return Effect.succeed(
      request.url.endsWith("/responses")
        ? HttpClientResponse.fromWeb(request, Response.json({ private: "vendor diagnostic" }, { status: 503 }))
        : reply(request),
    );
  });
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    yield* media.createUnderstanding(request);
    const job = yield* waitFor(media.get(request.id), (row) => row.phase === "unknown", "unknown inference");
    expect(job.problem).not.toContain("vendor diagnostic");
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(false);
    expect((yield* media.createUnderstanding(request)).phase).toBe("unknown");
    expect(calls).toHaveLength(2);
    expect((yield* media.previewUnderstandingCleanup(request.id)).does).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(false);
    expect((yield* media.cleanupUnderstanding(request.id)).cleanup).toBe("done");
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
    expect(calls.filter((url) => url.endsWith("/responses"))).toHaveLength(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: unknown uploads never trigger inference or blind account cleanup", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 })));
  });
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    yield* media.createUnderstanding(request);
    yield* waitFor(media.get(request.id), (row) => row.phase === "unknown", "unknown upload");
    const cleaned = yield* media.cleanupUnderstanding(request.id);
    expect(cleaned.cleanup).toBe("unknown");
    expect(cleaned.problem).toContain("vv-");
    expect(cleaned.canCleanup).toBe(false);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
    yield* media.createUnderstanding(request);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("cleanup retries only deletion and refuses changed credentials without losing the result", () => {
  let deletion = 503;
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(request.method);
    return Effect.succeed(request.method === "DELETE" ? HttpClientResponse.fromWeb(request, Response.json({}, { status: deletion })) : reply(request));
  });
  return Effect.gen(function* () {
    const { media, request } = yield* fixture;
    yield* media.createUnderstanding(request);
    yield* waitFor(media.get(request.id), (row) => row.kind === "understanding" && row.cleanup === "blocked", "cleanup failure");
    const provider = yield* Provider;
    const status = provider.status();
    yield* provider.update({ ...status, connections: status.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "replacement-key" })) });
    expect((yield* media.cleanupUnderstanding(request.id)).cleanup).toBe("blocked");
    expect(calls).toEqual(["POST", "POST", "DELETE"]);
    const changed = provider.status();
    yield* provider.update({
      ...changed,
      connections: changed.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "test-only-understanding-key" })),
    });
    deletion = 404;
    const cleaned = yield* media.cleanupUnderstanding(request.id);
    expect(cleaned.cleanup).toBe("done");
    expect(cleaned.result?.text).toBe("A synthetic green square.");
    expect(calls).toEqual(["POST", "POST", "DELETE", "DELETE"]);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("image and understanding tasks share capacity, IDs and cancellation without resubmission", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    yield* Effect.gen(function* () {
      const { media, request } = yield* fixture;
      yield* media.createUnderstanding(request);
      yield* Deferred.await(started);
      const image = { id: request.id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true } as const;
      const imageCreatedFailure = yield* media.createImage(image, { kind: "user" }).pipe(Effect.flip);
      expect(imageCreatedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, n) => `queued-${n}`),
        (id) => media.createImage({ ...image, id }, { kind: "user" }),
        { discard: true },
      );
      const understandingCreatedFailure = yield* media.createUnderstanding({ ...request, id: "overflow" }).pipe(Effect.flip);
      expect(understandingCreatedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, n) => `queued-${n}`),
        (id) => media.cancel(id),
        { discard: true },
      );
      expect((yield* media.cancel(request.id)).phase).toBe("canceled");
      expect((yield* media.createUnderstanding(request)).phase).toBe("canceled");
      expect((yield* media.cleanupUnderstanding(request.id)).cleanup).toBe("unknown");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("regression: disconnecting cleanup does not leave an unretryable running task", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let blocked = false;
    const http = HttpClient.make((request) =>
      request.method === "DELETE"
        ? blocked
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 })))
        : Effect.succeed(reply(request)),
    );
    yield* Effect.gen(function* () {
      const { media, request } = yield* fixture;
      yield* media.createUnderstanding(request);
      yield* waitFor(media.get(request.id), (row) => row.kind === "understanding" && row.cleanup === "blocked", "initial cleanup failed");
      blocked = true;
      const cleanup = yield* media.cleanupUnderstanding(request.id).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(cleanup);
      const media2 = yield* media.get(request.id);
      expect(media2).toMatchObject({ kind: "understanding", phase: "ready", cleanup: "blocked", canCleanup: true });
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect.each(["active", "failed", "processing"])("regression: upload status %s gates inference while retaining known IDs for deletion", (status) => {
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    return Effect.succeed(
      request.url.endsWith("/files")
        ? HttpClientResponse.fromWeb(
            request,
            Response.json({ id: "file-one", object: "file", bytes: bytes.length, created_at: 1, filename: "accepted.png", purpose: "image", status }),
          )
        : reply(request),
    );
  });
  return Effect.gen(function* () {
    const { media, request } = yield* fixture;
    yield* media.createUnderstanding(request);
    const phase = status === "active" ? "ready" : status === "failed" ? "failed" : "unknown";
    yield* waitFor(media.get(request.id), (job) => job.phase === phase, "file status handled");
    if (status !== "active") yield* media.cleanupUnderstanding(request.id);
    yield* waitFor(media.get(request.id), (job) => job.kind === "understanding" && job.cleanup === "done", "known file deleted");
    expect(calls.filter((call) => call.endsWith("/responses"))).toHaveLength(status === "active" ? 1 : 0);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: restart cancels unsent work, preserves uncertain work and results, and never resubmits", () => {
  const http = HttpClient.make(() => Effect.die("Recovery must not call the provider"));
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    const db = yield* Db;
    const inputs = yield* makeInputs;
    const reference = yield* media.inputs.get(input.id);
    const saved = {
      model: result.model,
      text: "Persisted result",
      status: "completed",
      incompleteReason: null,
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
    };
    yield* Effect.forEach(
      ["queued", "uploading", "generating", "ready"] as const,
      (phase) =>
        Effect.gen(function* () {
          const id = `restart-${phase}`;
          const asked = yield* json({ ...request, id });
          const pinned = yield* json([reference]);
          const owned = yield* json({ kind: "user" });
          const kept = phase === "ready" ? yield* json(saved) : null;
          yield* inputs.pin(
            [input.id],
            id,
            Effect.gen(function* () {
              yield* db.run(
                q.insertMediaJob(
                  newJob({
                    kind: "understanding",
                    id,
                    request: asked,
                    inputs: pinned,
                    source: owned,
                    authorization: null,
                    phase: "queued",
                    connection: "moss",
                    revision: request.revision,
                    model: "moss-vl-1.0",
                    now: 1,
                  }),
                ),
              );
              yield* db.run(
                q.changeMediaJob({
                  ...(yield* db.one(q.mediaJob({ id })).pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie)),
                  id,
                  phase,
                  source: owned,
                  result: kept,
                  cleanup: phase === "ready" ? "running" : "pending",
                  problem: "",
                  now: 1,
                }),
              );
            }),
          );
        }),
      { discard: true },
    );
    yield* media.restore();
    const media2 = yield* media.get("restart-queued");
    expect(media2).toMatchObject({ phase: "canceled", cleanup: "done" });
    const blobFailure = yield* inputs.blob(input.id, "restart-queued").pipe(Effect.flip);
    expect(blobFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    const media3 = yield* media.get("restart-uploading");
    expect(media3).toMatchObject({ phase: "unknown", cleanup: "pending" });
    const media4 = yield* media.get("restart-generating");
    expect(media4).toMatchObject({ phase: "unknown", cleanup: "pending" });
    const media5 = yield* media.get("restart-ready");
    expect(media5).toMatchObject({ phase: "ready", result: saved, cleanup: "blocked" });
    expect((yield* media.createUnderstanding({ ...request, id: "restart-generating" })).phase).toBe("unknown");
    expect((yield* Core).state().media).toHaveLength(4);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("user approval freezes inputs and authorizes only one trusted channel execution", () => {
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    return Effect.succeed(reply(request));
  });
  return Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    const channel = (yield* Channel).defaultChannel();
    const caller = { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true } as const;
    const granted = yield* media.authorizeUnderstanding({ ...request, channel });
    expect(granted.phase).toBe("authorized");
    expect(granted.authorization?.channel).toBe(channel);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(false);
    expect(calls).toEqual([]);
    for (const other of [{ kind: "user" } as const, { ...caller, forUser: false }, { ...caller, channel: "wrong-channel" }]) {
      const startFailure = yield* media.startUnderstanding(request.id, other).pipe(Effect.flip);
      expect(startFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    }
    const understandingCreatedFailure = yield* media.createUnderstanding(request).pipe(Effect.flip);
    expect(understandingCreatedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    const authorizeUnderstandingFailure = yield* media.authorizeUnderstanding({ ...request, channel, prompt: "Different question" }).pipe(Effect.flip);
    expect(authorizeUnderstandingFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect(calls).toEqual([]);
    yield* Effect.all([media.startUnderstanding(request.id, caller), media.startUnderstanding(request.id, caller)], { concurrency: 2 });
    const completed = yield* waitFor(media.get(request.id), (job) => job.kind === "understanding" && job.cleanup === "done", "authorized understanding");
    expect(completed).toMatchObject({ phase: "ready", source: { kind: "orchestrator", agent: caller.agent, channel } });
    const understandingStarted = yield* media.startUnderstanding(request.id, caller);
    expect(understandingStarted).toEqual(completed);
    const understandingStartedFailure = yield* media.startUnderstanding(request.id, { ...caller, agent: "other-agent" }).pipe(Effect.flip);
    expect(understandingStartedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect(calls).toEqual(["POST https://api.mosi.cn/v1/files", "POST https://api.mosi.cn/v1/responses", "DELETE https://api.mosi.cn/v1/files/file-one"]);
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
    const shown = (yield* Core).state().media;
    yield* notIn(shown, "fingerprint");
  }).pipe(Effect.provide(layer(http)));
});

it.effect.each(["cancel", "restart", "expire", "account"] as const)("unused approval cannot upload after %s", (action) =>
  Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    const channel = (yield* Channel).defaultChannel();
    const caller = { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true } as const;
    yield* media.authorizeUnderstanding({ ...request, channel });
    switch (action) {
      case "cancel":
        yield* media.cancel(request.id);
        break;
      case "restart":
        yield* media.restore();
        break;
      case "expire":
        yield* TestClock.adjust("15 minutes");
        const understandingStartedFailure = yield* media.startUnderstanding(request.id, caller).pipe(Effect.flip);
        expect(understandingStartedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
        yield* media.cancel(request.id);
        break;
      case "account": {
        const provider = yield* Provider;
        const state = provider.status();
        yield* provider.update({ ...state, connections: state.connections.map((item) => ({ ...item, key: "changed-account-key" })) });
        const understandingStartedFailure2 = yield* media.startUnderstanding(request.id, caller).pipe(Effect.flip);
        expect(understandingStartedFailure2).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
        yield* media.cancel(request.id);
        break;
      }
    }
    expect((yield* media.startUnderstanding(request.id, caller)).phase).toBe("canceled");
    expect((yield* media.inputs.get(input.id)).canDelete).toBe(true);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Invalidated approval must not contact the vendor"))))),
);

it.effect("regression: queued delegated understanding rechecks account before uploading", () =>
  Effect.gen(function* () {
    const { media, input, request } = yield* fixture;
    yield* media.createImage({ id: "hold-slot", prompt: "Hold", format: "text", width: 256, height: 256, enhance: false, watermark: true }, { kind: "user" });
    yield* waitFor(media.get("hold-slot"), (job) => job.phase === "generating", "shared execution slot occupied");
    const channel = (yield* Channel).defaultChannel();
    yield* media.authorizeUnderstanding({ ...request, channel });
    yield* media.startUnderstanding(request.id, { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true });
    const provider = yield* Provider;
    const status = provider.status();
    yield* provider.update({ ...status, connections: status.connections.map((item) => ({ ...item, key: "changed-before-upload" })) });
    yield* media.cancel("hold-slot");
    yield* waitFor(media.get(request.id), (job) => job.phase === "canceled", "stale queued approval rejected");
    yield* waitFor(media.inputs.get(input.id), (item) => item.canDelete, "input retention released");
  }).pipe(
    Effect.provide(
      layer(HttpClient.make((request) => (request.url.endsWith("/images/generations") ? Effect.never : Effect.die("Stale queued approval uploaded")))),
    ),
  ),
);
