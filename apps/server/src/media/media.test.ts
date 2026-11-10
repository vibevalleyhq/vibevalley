import { expect, it, layer as withLayer } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";

import { defaultOrchestrator, type MediaImageRequest } from "@vibevalley/protocol";

import { Attachment } from "#/attachment/attachment.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/media_generation.sql.ts";

import { Media, type MediaCaller } from "./media.ts";
import { png } from "./testdata/png.ts";

const pathOf = (...parts: readonly string[]) => Effect.map(Path.Path, (path) => path.join(...parts));

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });
const parsed = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const input: MediaImageRequest = { id: "image-test", prompt: "A quiet farm", format: "text", width: 256, height: 256, enhance: false, watermark: true };
const response = {
  created: 1,
  data: [{ url: "https://images.example.com/result.png?token=private" }],
  usage: { generated_images: 1, output_width: 256, output_height: 256 },
};
const generated = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response))));
const downloaded = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(png(), { headers: { "content-type": "image/png" } }))),
);
const configured = Effect.gen(function* () {
  yield* (yield* Provider).update({
    revision: 0,
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-private-key" }],
    image: { connection: "moss", model: "moss-image-sft-1.0" },
    understanding: null,
    speech: null,
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });
});
// world already builds Media; a fresh instance must capture these offline clients instead of reusing that service.
const layer = (http = generated, download = downloaded, config = testConfig()) =>
  Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(Layer.fresh(Provider.layer)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(Layer.succeed(PublicHttp, download)),
    Layer.provideMerge(world({ config })),
  );

it.effect("regression: startup projects an empty generation history before the first task", () =>
  Effect.gen(function* () {
    yield* (yield* Media).restore();
    expect((yield* Core).state().media).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("image tasks persist a result, keep bytes as an attachment, project safe state and deduplicate submissions", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    expect(request.headers.authorization).toBe("Bearer test-private-key");
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
  });
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    const first = yield* media.createImage(input, { kind: "user" });
    expect(first.phase).toBe("queued");
    expect(first.source).toEqual({ kind: "user" });
    expect(first.usage).toBeUndefined();
    const ready = yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "image saved");
    if (ready.kind !== "image") return yield* Effect.die("Expected image task");
    expect(ready.attachment?.type).toBe("image/png");
    expect(ready.usage).toEqual({ images: 1, width: 256, height: 256 });
    expect(ready.canCancel).toBe(false);
    const attachment2 = yield* (yield* Attachment).get(ready.attachment?.id ?? "");
    expect(attachment2).toBeDefined();
    const { watermark, ...rest } = input;
    expect((yield* media.createImage({ watermark, ...rest }, { kind: "user" })).id).toBe(input.id);
    const imageCreatedFailure = yield* media.createImage({ ...input, prompt: "different" }, { kind: "user" }).pipe(Effect.flip);
    expect(imageCreatedFailure).toMatchObject({ _tag: "Refused" });
    expect(calls).toBe(1);
    const row = yield* (yield* Db).one(q.generation({ id: input.id }));
    expect(row?.result_url).toBeNull();
    yield* notIn(row, "test-private-key");
    const state = (yield* Core).state();
    expect(state.media?.[0]).toMatchObject({ kind: "image", attachment: { id: ready.attachment?.id } });
    yield* notIn(state.media, "token=private");
  }).pipe(Effect.provide(layer(http)));
});

it.effect("download failures retry only downloads and refuse unsafe regeneration", () => {
  let generations = 0;
  let downloads = 0;
  const http = HttpClient.make((request) => {
    generations++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
  });
  const download = HttpClient.make((request) => {
    downloads++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        downloads === 1 ? new Response("bad", { status: 503 }) : new Response(png(), { headers: { "content-type": "image/png" } }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    yield* media.createImage(input, { kind: "user" });
    const failed = yield* waitFor(media.get(input.id), (job) => job.phase === "download_failed", "failed download");
    if (failed.kind !== "image") return yield* Effect.die("Expected image task");
    expect(failed.canRetryDownload).toBe(true);
    expect(failed.usage).toEqual({ images: 1, width: 256, height: 256 });
    yield* media.retryDownload(input.id);
    yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "download retry saved");
    expect(generations).toBe(1);
    expect(downloads).toBe(2);
    yield* media.retryDownload(input.id);
    expect(downloads).toBe(2);
  }).pipe(Effect.provide(layer(http, download)));
});

it.effect("regression: an attachment disk failure preserves usage and retries only saving the generated result", () => {
  const config = testConfig();
  let generations = 0;
  const http = HttpClient.make((request) => {
    generations++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
  });
  return Effect.gen(function* () {
    yield* configured;
    const fs = yield* FileSystem.FileSystem;
    const blocked = yield* pathOf(config.home, "attachments");
    yield* fs.writeFileString(blocked, "not a directory");
    const media = yield* Media;
    yield* media.createImage(input, { kind: "user" });
    const failed = yield* waitFor(media.get(input.id), (row) => row.phase === "download_failed", "disk failure recorded");
    if (failed.kind !== "image") return yield* Effect.die("Expected image task");
    expect(failed.usage).toEqual({ images: 1, width: 256, height: 256 });
    expect(failed.attachment).toBeUndefined();
    expect(failed.problem).not.toContain(config.home);
    yield* fs.remove(blocked);
    yield* media.retryDownload(input.id);
    yield* waitFor(media.get(input.id), (row) => row.phase === "ready", "image saved after disk repair");
    expect(generations).toBe(1);
  }).pipe(Effect.provide(layer(http, downloaded, config)));
});

it.effect("regression: queued generations keep their account snapshot after key rotation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const keys: (string | undefined)[] = [];
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        keys.push(request.headers.authorization);
        if (keys.length === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
        return HttpClientResponse.fromWeb(request, Response.json(response));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      const provider = yield* Provider;
      yield* media.createImage(input, { kind: "user" });
      yield* Deferred.await(started);
      yield* media.createImage({ ...input, id: "queued-snapshot" }, { kind: "user" });
      const before = provider.status();
      yield* provider.update({
        ...before,
        connections: before.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "rotated-test-key" })),
      });
      yield* Deferred.succeed(release, undefined);
      yield* waitFor(media.get("queued-snapshot"), (row) => row.phase === "ready", "queued snapshot completed");
      yield* media.createImage({ ...input, id: "new-snapshot" }, { kind: "user" });
      yield* waitFor(media.get("new-snapshot"), (row) => row.phase === "ready", "new snapshot completed");
      expect(keys).toEqual(["Bearer test-private-key", "Bearer test-private-key", "Bearer rotated-test-key"]);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("regression: disconnecting the submitter after persistence cannot strand an admitted task", () =>
  Effect.gen(function* () {
    yield* configured;
    const core = yield* Core;
    const admitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let pause = true;
    const delayed = Core.of({
      ...core,
      apply: (...facts) =>
        Effect.gen(function* () {
          yield* core.apply(...facts);
          if (pause && facts.some((fact) => fact.type === "mediaChanged")) {
            pause = false;
            yield* Deferred.succeed(admitted, undefined);
            yield* Deferred.await(release);
          }
        }),
    });
    const built = yield* Layer.build(Layer.fresh(Media.layer).pipe(Layer.provide(Layer.succeed(Core, delayed))));
    const media = Context.get(built, Media);
    const request = yield* media.createImage(input, { kind: "user" }).pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    const interrupt = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupt);
    expect((yield* Fiber.await(request))._tag).toBe("Failure");
    yield* waitFor(media.get(input.id), (row) => row.phase === "ready", "admitted task outlives submitter");
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("regression: canceling an old download cannot interrupt its explicitly started retry", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    let downloads = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        downloads++;
        if (downloads === 1) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(cleanup)));
        }
        return HttpClientResponse.fromWeb(request, new Response(png(), { headers: { "content-type": "image/png" } }));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      yield* media.createImage(input, { kind: "user" });
      yield* Deferred.await(started);
      const cancel = yield* media.cancel(input.id).pipe(Effect.forkChild);
      yield* waitFor(media.get(input.id), (row) => row.phase === "canceled", "old download canceled");
      yield* media.retryDownload(input.id);
      yield* Deferred.succeed(cleanup, undefined);
      yield* Fiber.join(cancel);
      yield* waitFor(media.get(input.id), (row) => row.phase === "ready", "new download survives cancellation");
      expect(downloads).toBe(2);
    }).pipe(Effect.provide(layer(generated, http)));
  }),
);

it.effect("queued cancellation, capacity and in-flight cancellation do not create more vendor requests", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    yield* Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      yield* media.createImage(input, { kind: "user" });
      yield* Deferred.await(started);
      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, n) => ({ ...input, id: `queued-${n}` })),
        (request) => media.createImage(request, { kind: "user" }),
        { discard: true },
      );
      const imageCreatedFailure = yield* media.createImage({ ...input, id: "overflow" }, { kind: "user" }).pipe(Effect.flip);
      expect(imageCreatedFailure).toMatchObject({ _tag: "Refused" });
      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, n) => `queued-${n}`),
        (id) => media.cancel(id),
        { discard: true },
      );
      expect((yield* media.cancel(input.id)).phase).toBe("canceled");
      expect(calls).toBe(1);
      expect((yield* media.createImage(input, { kind: "user" })).phase).toBe("canceled");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("ambiguous vendor failures are not retried and cannot use download retry", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("private upstream error", { status: 503 })));
  });
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    yield* media.createImage(input, { kind: "user" });
    const job = yield* waitFor(media.get(input.id), (row) => row.phase === "unknown", "unknown outcome");
    if (job.kind !== "image") return yield* Effect.die("Expected image task");
    yield* notIn(job, "private upstream error");
    expect(job.usage).toBeUndefined();
    const downloadRetriedFailure = yield* media.retryDownload(input.id).pipe(Effect.flip);
    expect(downloadRetriedFailure).toMatchObject({ _tag: "Refused" });
    yield* media.createImage(input, { kind: "user" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("generation source and reported usage survive restart without accepting a different caller", () => {
  const config = testConfig({ db: "" });
  const caller: MediaCaller = { kind: "orchestrator", agent: "image-agent", channel: "image-channel", forUser: true };
  const source = { kind: "orchestrator", agent: "image-agent", channel: "image-channel" };
  return Effect.gen(function* () {
    const saved = yield* Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      yield* media.createImage(input, caller);
      const ready = yield* waitFor(media.get(input.id), (row) => row.phase === "ready", "attributed image saved");
      if (ready.kind !== "image") return yield* Effect.die("Expected image task");
      expect(ready.source).toEqual(source);
      const row = yield* (yield* Db).one(q.generation({ id: input.id }));
      const sourceJson = yield* json(source);
      expect(row?.source).toBe(sourceJson);
      const usage = yield* parsed(row?.usage ?? "null");
      expect(usage).toEqual(ready.usage);
      return ready;
    }).pipe(Effect.provide(layer(generated, downloaded, config)));
    yield* Effect.gen(function* () {
      const media = yield* Media;
      yield* media.restore();
      const media2 = yield* media.get(input.id);
      expect(media2).toEqual(saved);
      const imageCreated = yield* media.createImage(input, caller);
      expect(imageCreated).toEqual(saved);
      const imageCreatedFailure = yield* media.createImage(input, { kind: "user" }).pipe(Effect.flip);
      expect(imageCreatedFailure).toMatchObject({ _tag: "Refused" });
      const imageCreatedFailure2 = yield* media.createImage(input, { ...caller, agent: "another-agent" }).pipe(Effect.flip);
      expect(imageCreatedFailure2).toMatchObject({ _tag: "Refused" });
      expect((yield* Core).state().media?.[0]?.source).toEqual(source);
    }).pipe(Effect.provide(layer(generated, downloaded, config)));
  });
});

it.effect("regression: autonomous patrols cannot admit a billable generation", () =>
  Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    const imageCreatedFailure = yield* media.createImage(input, { kind: "orchestrator", agent: "image-agent", channel: "", forUser: false }).pipe(Effect.flip);
    expect(imageCreatedFailure).toMatchObject({
      _tag: "Refused",
    });
    const medias = yield* media.list();
    expect(medias).toEqual([]);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Autonomous generation must not reach HTTP"))))),
);

it.effect("restart marks unsent and ambiguous tasks separately and resumes only stored downloads", () => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.die("Restart must not generate");
  });
  return Effect.gen(function* () {
    const db = yield* Db;
    for (const phase of ["queued", "generating", "downloading"] as const) {
      yield* db.run(
        q.insertGeneration({
          id: phase,
          request: yield* json({ ...input, id: phase }),
          source: yield* json({ kind: "user" }),
          connection: "moss",
          revision: 1,
          model: "moss-image-sft-1.0",
          now: 1,
        }),
      );
      yield* db.run(
        q.changeGeneration({
          id: phase,
          phase,
          attachment: null,
          usage: null,
          result_url: phase === "downloading" ? (response.data[0]?.url ?? null) : null,
          problem: "",
          now: 1,
        }),
      );
    }
    const media = yield* Media;
    yield* media.restore();
    expect((yield* media.get("queued")).phase).toBe("canceled");
    expect((yield* media.get("generating")).phase).toBe("unknown");
    yield* waitFor(media.get("downloading"), (row) => row.phase === "ready", "restored download");
    expect(calls).toBe(0);
  }).pipe(Effect.provide(layer(http)));
});

withLayer(layer())("images asked for in a channel", (it) => {
  it.effect("an image an orchestrator was asked for in a channel is posted back there under its name, once; the user's own stays", () =>
    Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      const chat = yield* Channel;
      const sql = yield* SqlClient.SqlClient;
      const channel = chat.defaultChannel();
      const postsOf = (id: string) =>
        Effect.map(
          sql<{ sender_id: string; meta: string }>`select sender_id, meta from channel_message where send_key = ${`media:${id}`}`.pipe(Effect.orDie),
          (rows) => [...rows],
        );
      // One execution slot runs the tasks in turn: once the orchestrator's image is posted, the user's task is through too.
      yield* media.createImage({ ...input, id: "users-own" }, { kind: "user" });
      yield* media.createImage({ ...input, id: "asked-in-channel" }, { kind: "orchestrator", agent: defaultOrchestrator, channel, forUser: true });
      const posted = yield* waitFor(postsOf("asked-in-channel"), (rows) => rows.length > 0, "the image posted back");
      const ready = yield* media.get("asked-in-channel");
      if (ready.kind !== "image") return yield* Effect.die("Expected image task");
      expect(posted).toMatchObject([{ sender_id: defaultOrchestrator }]);
      expect(posted[0]?.meta).toContain(ready.attachment?.id ?? "missing");
      const usersPosts = yield* postsOf("users-own");
      expect(usersPosts).toEqual([]);
      // A restart posts what is ready again; the send key keeps it once.
      yield* media.restore();
      const afterRestart = yield* postsOf("asked-in-channel");
      expect(afterRestart).toHaveLength(1);
    }),
  );
});
