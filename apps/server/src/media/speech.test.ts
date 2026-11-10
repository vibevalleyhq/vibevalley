import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Formatter, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type * as T from "@vibevalley/protocol";

import { Attachment } from "#/attachment/attachment.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/media_job.sql.ts";

import { newJob } from "./job.ts";
import { Media, type MediaCaller } from "./media.ts";
import { mp3, wav } from "./testdata/audio.ts";

const pathOf = (...parts: readonly string[]) => Effect.map(Path.Path, (path) => path.join(...parts));

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });
const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const input: T.MediaSpeechRequest = { id: "speech-test", text: "A quiet farm.", voice: "voice-test", format: "wav", connection: "moss", revision: 1 };
const response = {
  id: "speech-result",
  object: "audio.speech",
  status: "SUCCESS",
  created_at: 1,
  url: "https://audio.example.com/result.wav?token=private",
  response_format: "wav",
  content_type: "audio/wav",
};
const generated = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response))));
const downloaded = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(wav(), { headers: { "content-type": "audio/wav" } }))),
);
const configured = Effect.fnUntraced(function* (model = "moss-tts-1.5-flash") {
  yield* (yield* Provider).update({
    revision: 0,
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-private-key" }],
    image: { connection: "moss", model: "moss-image-sft-1.0" },
    understanding: null,
    speech: { connection: "moss", model },
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });
});
const layer = (http = generated, download = downloaded, config = testConfig()) =>
  Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(Layer.fresh(Provider.layer)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(Layer.succeed(PublicHttp, download)),
    Layer.provideMerge(world({ config })),
  );

it.effect.each([
  ["moss-tts-1.5-flash", "wav"],
  ["moss-tts-1.0-pro", "mp3"],
] as const)("persists the model/format pair %j once with safe state and idempotent submissions", ([model, format]) => {
  let calls = 0;
  const bytes = format === "wav" ? wav() : mp3;
  const type = format === "wav" ? "audio/wav" : "audio/mpeg";
  const http = HttpClient.make((request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(request.headers.authorization).toBe("Bearer test-private-key");
    if (request.body._tag === "Uint8Array") {
      expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toMatchObject({
        model,
        input: input.text,
        voice_id: input.voice,
        stream: false,
        async: false,
      });
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ...response, response_format: format, content_type: type })));
  });
  return Effect.gen(function* () {
    yield* configured(model);
    const media = yield* Media;
    const submitted = { ...input, format };
    expect((yield* media.createSpeech(submitted, { kind: "user" })).phase).toBe("queued");
    const ready = yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "speech saved");
    if (ready.kind !== "speech") return yield* Effect.die("Expected speech task");
    expect(ready).toMatchObject({ model, voice: input.voice, format, connection: "moss", revision: 1, source: { kind: "user" }, canCancel: false });
    expect(ready.attachment?.type).toBe(type);
    const file = yield* (yield* Attachment).get(ready.attachment?.id ?? "");
    if (!file) return yield* Effect.die("Expected local speech attachment");
    const file2 = yield* (yield* FileSystem.FileSystem).readFile(file.path);
    expect(Buffer.from(file2)).toEqual(bytes);
    const { text, ...rest } = submitted;
    const speechCreated = yield* media.createSpeech({ text, ...rest }, { kind: "user" });
    expect(speechCreated).toEqual(ready);
    for (const patch of [{ text: "Changed" }, { voice: "another-voice" }, { revision: 2 }, { format: format === "wav" ? "mp3" : "wav" }] as const) {
      const changedFailure = yield* media.createSpeech({ ...submitted, ...patch }, { kind: "user" }).pipe(Effect.flip);
      expect(changedFailure).toMatchObject({ _tag: "Refused" });
    }
    expect(calls).toBe(1);
    const row = yield* (yield* Db).one(q.mediaJob({ id: input.id }));
    expect(row?.result_url).toBeNull();
    yield* notIn(row, "test-private-key");
    const jobs = (yield* Core).state().media;
    expect(jobs?.[0]).toMatchObject({ kind: "speech", attachment: { id: ready.attachment?.id } });
    yield* notIn(jobs, "token=private");
  }).pipe(
    Effect.provide(
      layer(
        http,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bytes, { headers: { "content-type": type } })))),
      ),
    ),
  );
});

it.effect("regression: synchronous speech retains observed usage and actual format without changing its retry identity", () => {
  let calls = 0;
  const usage = { inputCharacters: 13, promptTokens: 23, completionTokens: 12, totalTokens: 35 };
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ ...response, usage: { input_characters: 13, prompt_tokens: 23, completion_tokens: 12, total_tokens: 35 } }),
      ),
    );
  });
  const download = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(wav(4800), { headers: { "content-type": "audio/wav" } }))),
  );
  return Effect.gen(function* () {
    yield* configured();
    const media = yield* Media;
    const request = { ...input, format: "mp3" as const };
    yield* media.createSpeech(request, { kind: "user" });
    const ready = yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "actual speech format saved");
    expect(ready).toMatchObject({
      format: "wav",
      contentType: "audio/wav",
      usage,
      metadata: { source: "file", sampleRate: 24000, channels: 1, bitDepth: 16, duration: 0.2 },
      attachment: { type: "audio/wav" },
    });
    const speechCreated = yield* media.createSpeech(request, { kind: "user" });
    expect(speechCreated).toEqual(ready);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http, download)));
});

it.effect("regression: speech download starts only after the private URL is stored and retries never synthesize", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    let downloads = 0;
    const http = HttpClient.make((request) => {
      calls++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
    });
    const download = HttpClient.make((request) =>
      Effect.gen(function* () {
        downloads++;
        expect(request.headers.authorization).toBeUndefined();
        if (downloads === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return HttpClientResponse.fromWeb(request, new Response("broken", { status: 503 }));
        }
        return HttpClientResponse.fromWeb(request, new Response(wav(), { headers: { "content-type": "audio/wav" } }));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech(input, { kind: "user" });
      yield* Deferred.await(started);
      const found = yield* (yield* Db).one(q.mediaJob({ id: input.id }));
      expect(found).toMatchObject({ phase: "downloading", result_url: response.url });
      const shown = (yield* Core).state().media;
      yield* notIn(shown, "token=private");
      yield* Deferred.succeed(release, undefined);
      expect((yield* waitFor(media.get(input.id), (job) => job.phase === "download_failed", "speech download failed")).canRetryDownload).toBe(true);
      yield* media.retryDownload(input.id);
      yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "speech download retried");
      yield* media.retryDownload(input.id);
      expect(calls).toBe(1);
      expect(downloads).toBe(2);
    }).pipe(Effect.provide(layer(http, download)));
  }),
);

it.effect("regression: speech attachment disk failures retain the result for download-only recovery", () => {
  const config = testConfig();
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
  });
  return Effect.gen(function* () {
    yield* configured();
    const fs = yield* FileSystem.FileSystem;
    const blocked = yield* pathOf(config.home, "attachments");
    yield* fs.writeFileString(blocked, "not a directory");
    const media = yield* Media;
    yield* media.createSpeech(input, { kind: "user" });
    const failed = yield* waitFor(media.get(input.id), (job) => job.phase === "download_failed", "speech disk failure");
    expect(failed.problem).not.toContain(config.home);
    yield* fs.remove(blocked);
    yield* media.retryDownload(input.id);
    yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "speech saved after disk repair");
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http, downloaded, config)));
});

it.effect("regression: queued speech freezes its selected model and credentials; stale choices cannot submit", () =>
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
      yield* configured();
      const media = yield* Media;
      const provider = yield* Provider;
      yield* media.createSpeech(input, { kind: "user" });
      yield* Deferred.await(started);
      yield* media.createSpeech({ ...input, id: "speech-queued" }, { kind: "user" });
      const before = provider.status();
      yield* provider.update({
        ...before,
        connections: before.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "rotated-test-key" })),
        speech: { connection: "moss", model: "moss-tts-1.0-pro" },
      });
      const speechCreatedFailure = yield* media.createSpeech({ ...input, id: "stale" }, { kind: "user" }).pipe(Effect.flip);
      expect(speechCreatedFailure).toMatchObject({ _tag: "Refused" });
      yield* Deferred.succeed(release, undefined);
      expect((yield* waitFor(media.get("speech-queued"), (job) => job.phase === "ready", "frozen speech completed")).model).toBe("moss-tts-1.5-flash");
      yield* media.createSpeech({ ...input, id: "speech-fresh", revision: provider.status().revision }, { kind: "user" });
      expect((yield* waitFor(media.get("speech-fresh"), (job) => job.phase === "ready", "fresh speech completed")).model).toBe("moss-tts-1.0-pro");
      expect(keys).toEqual(["Bearer test-private-key", "Bearer test-private-key", "Bearer rotated-test-key"]);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("regression: canceling an old speech download cannot cancel its explicit retry", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    let downloads = 0;
    const download = HttpClient.make((request) =>
      Effect.gen(function* () {
        downloads++;
        if (downloads === 1) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(cleanup)));
        }
        return HttpClientResponse.fromWeb(request, new Response(wav(), { headers: { "content-type": "audio/wav" } }));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech(input, { kind: "user" });
      yield* Deferred.await(started);
      const cancel = yield* media.cancel(input.id).pipe(Effect.forkChild);
      expect((yield* waitFor(media.get(input.id), (job) => job.phase === "canceled", "speech waiting canceled")).canRetryDownload).toBe(true);
      yield* media.retryDownload(input.id);
      yield* Deferred.succeed(cleanup, undefined);
      yield* Fiber.join(cancel);
      yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "speech retry survives old cancellation");
      expect(downloads).toBe(2);
    }).pipe(Effect.provide(layer(generated, download)));
  }),
);

it.effect("speech shares image capacity and the ID namespace without sending canceled queued tasks", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      const image: T.MediaImageRequest = { id: "shared-image", prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true };
      yield* media.createImage(image, { kind: "user" });
      yield* Deferred.await(started);
      const speechCreatedFailure = yield* media.createSpeech({ ...input, id: image.id }, { kind: "user" }).pipe(Effect.flip);
      expect(speechCreatedFailure).toMatchObject({ _tag: "Refused" });
      for (let index = 0; index < 7; index++) yield* media.createSpeech({ ...input, id: `queued-${index}` }, { kind: "user" });
      const imageCreatedFailure = yield* media.createImage({ ...image, id: "queued-0" }, { kind: "user" }).pipe(Effect.flip);
      expect(imageCreatedFailure).toMatchObject({ _tag: "Refused" });
      const speechCreatedFailure2 = yield* media.createSpeech(input, { kind: "user" }).pipe(Effect.flip);
      expect(speechCreatedFailure2).toMatchObject({ _tag: "Refused" });
      for (let index = 0; index < 7; index++) expect((yield* media.cancel(`queued-${index}`)).phase).toBe("canceled");
      yield* media.cancel(image.id);
      expect((yield* media.createSpeech({ ...input, id: "queued-0" }, { kind: "user" })).phase).toBe("canceled");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect.each([400, 503])("HTTP %i speech outcomes never resubmit synthesis", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("private upstream error", { status })));
  });
  return Effect.gen(function* () {
    yield* configured();
    const media = yield* Media;
    yield* media.createSpeech(input, { kind: "user" });
    const job = yield* waitFor(media.get(input.id), (row) => row.phase === (status === 400 ? "failed" : "unknown"), "speech failure recorded");
    yield* notIn(job, "private upstream error");
    const downloadRetriedFailure = yield* media.retryDownload(input.id).pipe(Effect.flip);
    expect(downloadRetriedFailure).toMatchObject({ _tag: "Refused" });
    yield* media.createSpeech(input, { kind: "user" });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: canceling synthesis stops local waiting without granting a synthesis retry", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    let interrupted = false;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
    });
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech(input, { kind: "user" });
      yield* Deferred.await(started);
      expect((yield* media.cancel(input.id)).phase).toBe("canceled");
      expect(interrupted).toBe(true);
      expect((yield* media.createSpeech(input, { kind: "user" })).phase).toBe("canceled");
      const downloadRetriedFailure = yield* media.retryDownload(input.id).pipe(Effect.flip);
      expect(downloadRetriedFailure).toMatchObject({ _tag: "Refused" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("regression: stopping the service during speech submission retains uncertainty across restart", () => {
  const config = testConfig({ db: "" });
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const http = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)));
    yield* Effect.gen(function* () {
      yield* configured();
      yield* (yield* Media).createSpeech(input, { kind: "user" });
      yield* Deferred.await(started);
    }).pipe(Effect.provide(layer(http, downloaded, config)));
    yield* Effect.gen(function* () {
      const media = yield* Media;
      yield* media.restore();
      expect((yield* media.get(input.id)).phase).toBe("unknown");
      expect((yield* media.createSpeech(input, { kind: "user" })).phase).toBe("unknown");
      const downloadRetriedFailure = yield* media.retryDownload(input.id).pipe(Effect.flip);
      expect(downloadRetriedFailure).toMatchObject({ _tag: "Refused" });
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() => Effect.die("Uncertain speech cannot resubmit")),
          downloaded,
          config,
        ),
      ),
    );
  });
});

it.effect("regression: autonomous callers, invalid voices and unsupported Pro pause tags never admit speech", () =>
  Effect.gen(function* () {
    yield* configured("moss-tts-1.0-pro");
    const media = yield* Media;
    const speechCreatedFailure = yield* media
      .createSpeech(input, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: false })
      .pipe(Effect.flip);
    expect(speechCreatedFailure).toMatchObject({
      _tag: "Refused",
    });
    for (const patch of [{ voice: "../voice" }, { text: " " }, { text: "Hello [pause 1s] world" }]) {
      const invalidFailure = yield* media.createSpeech({ ...input, ...patch }, { kind: "user" }).pipe(Effect.flip);
      expect(invalidFailure).toMatchObject({ _tag: "Refused" });
    }
    const medias = yield* media.list();
    expect(medias).toEqual([]);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Invalid speech reached vendor"))))),
);

it.effect("speech source and completed attachment survive restart without accepting a different caller", () => {
  const config = testConfig({ db: "" });
  const caller: MediaCaller = { kind: "orchestrator", agent: "speech-agent", channel: "speech-channel", forUser: true };
  const source = { kind: "orchestrator", agent: "speech-agent", channel: "speech-channel" };
  return Effect.gen(function* () {
    const saved = yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech(input, caller);
      const ready = yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "attributed speech saved");
      expect(ready.source).toEqual(source);
      const sourceJson = yield* json(source);
      expect((yield* (yield* Db).one(q.mediaJob({ id: input.id })))?.source).toBe(sourceJson);
      return ready;
    }).pipe(Effect.provide(layer(generated, downloaded, config)));
    yield* Effect.gen(function* () {
      const media = yield* Media;
      yield* media.restore();
      const media2 = yield* media.get(input.id);
      expect(media2).toEqual(saved);
      const speechCreated = yield* media.createSpeech(input, caller);
      expect(speechCreated).toEqual(saved);
      const speechCreatedFailure = yield* media.createSpeech(input, { kind: "user" }).pipe(Effect.flip);
      expect(speechCreatedFailure).toMatchObject({ _tag: "Refused" });
      const speechCreatedFailure2 = yield* media.createSpeech(input, { ...caller, channel: "another-channel" }).pipe(Effect.flip);
      expect(speechCreatedFailure2).toMatchObject({ _tag: "Refused" });
      expect((yield* Core).state().media?.[0]?.source).toEqual(source);
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() => Effect.die("Restart cannot synthesize")),
          downloaded,
          config,
        ),
      ),
    );
  });
});

it.effect("restart cancels unsent speech, marks uncertainty and resumes only persisted downloads", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    for (const phase of ["queued", "generating", "downloading", "download_failed", "canceled"] as const) {
      yield* db.run(
        q.insertMediaJob(
          newJob({
            kind: "speech",
            phase: "queued",
            id: phase,
            request: yield* json({ ...input, id: phase }),
            source: yield* json({ kind: "user" }),
            connection: input.connection,
            revision: input.revision,
            model: "moss-tts-1.5-flash",
            credential_hash: "",
            now: 1,
          }),
        ),
      );
      yield* db.run(
        q.changeSpeechJob({
          id: phase,
          phase,
          attachment: null,
          remote_task: null,
          result_format: null,
          content_type: null,
          metadata: null,
          usage: null,
          result_input: null,
          result_url: phase === "queued" || phase === "generating" ? null : response.url,
          problem: "",
          now: 1,
        }),
      );
    }
    const media = yield* Media;
    yield* media.restore();
    expect((yield* media.get("queued")).phase).toBe("canceled");
    expect((yield* media.get("generating")).phase).toBe("unknown");
    yield* waitFor(media.get("downloading"), (job) => job.phase === "ready", "restored speech download");
    for (const id of ["download_failed", "canceled"]) {
      expect((yield* media.get(id)).phase).toBe(id);
      yield* media.retryDownload(id);
      yield* waitFor(media.get(id), (job) => job.phase === "ready", "explicit recovered download");
    }
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Recovery cannot synthesize"))))),
);

it.effect("regression: disconnecting the speech submitter cannot strand an admitted task", () =>
  Effect.gen(function* () {
    yield* configured();
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
    const request = yield* media.createSpeech(input, { kind: "user" }).pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    const interrupt = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupt);
    expect((yield* Fiber.await(request))._tag).toBe("Failure");
    yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "admitted speech outlives submitter");
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("regression: asynchronous speech persists its task before polling and cancellation resumes only that task", () =>
  Effect.gen(function* () {
    const polling = yield* Deferred.make<void>();
    let submissions = 0;
    let polls = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.method === "POST") {
          submissions++;
          return HttpClientResponse.fromWeb(request, Response.json({ task_id: "remote-speech" }));
        }
        polls++;
        expect(request.url).toBe("https://api.mosi.cn/v1/audio/tasks/remote-speech");
        expect(request.headers.authorization).toBe("Bearer test-private-key");
        if (polls === 1) {
          yield* Deferred.succeed(polling, undefined);
          return yield* Effect.never;
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            ...response,
            id: "remote-speech",
            updated_at: 2,
            response_format: "mp3",
            content_type: "audio/mpeg",
          }),
        );
      }),
    );
    const download = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(mp3, { headers: { "content-type": "audio/mpeg" } }))),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech({ ...input, asynchronous: true }, { kind: "user" });
      yield* Deferred.await(polling);
      const found = yield* (yield* Db).one(q.mediaJob({ id: input.id }));
      expect(found).toMatchObject({ phase: "generating", remote_task: "remote-speech" });
      const canceled = yield* media.cancel(input.id);
      expect(canceled).toMatchObject({ phase: "canceled", canResume: true });
      yield* media.speechResume(input.id);
      const ready = yield* waitFor(media.get(input.id), (job) => job.phase === "ready", "resumed asynchronous speech");
      expect(ready).toMatchObject({ kind: "speech", format: "mp3", contentType: "audio/mpeg", metadata: { source: "file" } });
      expect(submissions).toBe(1);
      expect(polls).toBe(2);
      const shown = (yield* Core).state().media;
      yield* notIn(shown, "remote-speech");
    }).pipe(Effect.provide(layer(http, download)));
  }),
);

it.effect("regression: restart never queries a known asynchronous task with replaced credentials", () =>
  Effect.gen(function* () {
    yield* configured();
    const db = yield* Db;
    yield* db.run(
      q.insertMediaJob(
        newJob({
          kind: "speech",
          phase: "queued",
          id: input.id,
          request: yield* json({ ...input, asynchronous: true }),
          source: yield* json({ kind: "user" }),
          connection: input.connection,
          revision: input.revision,
          model: "moss-tts-1.5-flash",
          credential_hash: "different-original-key-fingerprint",
          now: 1,
        }),
      ),
    );
    const row = yield* db.one(q.mediaJob({ id: input.id }));
    if (!row) return yield* Effect.die("Missing seeded speech");
    yield* db.run(q.changeSpeechJob({ ...row, phase: "generating", remote_task: "known-before-restart", now: 2 }));
    const media = yield* Media;
    yield* media.restore();
    const paused = yield* waitFor(media.get(input.id), (job) => job.phase === "unknown", "credential mismatch pauses polling");
    expect(paused).toMatchObject({ canResume: true });
    const speechResumeFailure = yield* media.speechResume(input.id).pipe(Effect.flip);
    expect(speechResumeFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* db.one(q.mediaJob({ id: input.id })))?.remote_task).toBe("known-before-restart");
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Changed credentials must not reach MOSS"))))),
);

it.effect("regression: Flash delivers PCM before completion and saves actual metadata only after the terminal event", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const encode = (event: object) => new TextEncoder().encode(`data: ${Formatter.formatJson(event)}\n\n`);
    const pcm = wav().subarray(44);
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const beginning = Stream.make(
          encode({ type: "task.created", task_id: "stream-private-id", object: "audio.speech", status: "PROCESSING", model: "moss-tts-1.5-flash" }),
          encode({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 1, bit_depth: 16 }),
          encode({ type: "speech.audio.delta", audio: pcm.subarray(0, 1).toString("base64") }),
          encode({ type: "speech.audio.delta", audio: pcm.subarray(1).toString("base64") }),
        );
        const terminal = Stream.fromEffect(
          Deferred.await(finish).pipe(
            Effect.as(
              encode({
                type: "speech.audio.done",
                usage: { input_characters: 13, prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
                meta_info: { performance: { audio_duration_s: 0.12 } },
              }),
            ),
          ),
        );
        const body = yield* Stream.toReadableStreamEffect(Stream.concat(beginning, terminal));
        return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech({ ...input, streaming: true, format: "pcm" }, { kind: "user" });
      const events: T.MediaSpeechEvent[] = [];
      const reader = yield* (yield* media.speechEvents(input.id)).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "audio") yield* Deferred.succeed(first, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(first);
      expect((yield* media.get(input.id)).phase).toBe("generating");
      expect((yield* (yield* Db).one(q.mediaJob({ id: input.id })))?.remote_task).toBe("stream-private-id");
      const speechEventsFailure = yield* media.speechEvents(input.id).pipe(Effect.flip);
      expect(speechEventsFailure).toMatchObject({ _tag: "Refused" });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(reader);
      expect(events.map((event) => event.type)).toEqual(["format", "audio", "done"]);
      const ready = yield* media.get(input.id);
      expect(ready).toMatchObject({
        phase: "ready",
        format: "wav",
        contentType: "audio/wav",
        metadata: { source: "provider", sampleRate: 24000, channels: 1, bitDepth: 16, duration: 0.12 },
        usage: { inputCharacters: 13, promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      });
      const shown = (yield* Core).state().media;
      yield* notIn(shown, "stream-private-id");
    }).pipe(Effect.provide(layer(http)));
  }),
);

it.effect("regression: EOF is not Flash completion and the received partial WAV remains available", () => {
  const encode = (event: object) => `data: ${Formatter.formatJson(event)}\n\n`;
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          encode({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 1, bit_depth: 16 }) +
            encode({ type: "speech.audio.delta", audio: wav().subarray(44).toString("base64") }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* configured();
    const media = yield* Media;
    yield* media.createSpeech({ ...input, streaming: true, format: "pcm" }, { kind: "user" });
    const events = yield* (yield* media.speechEvents(input.id)).pipe(Stream.runCollect);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const partial = yield* media.get(input.id);
    expect(partial).toMatchObject({ phase: "unknown", format: "wav", canResume: false, attachment: { name: `moss-${input.id}-partial.wav` } });
  }).pipe(Effect.provide(layer(http)));
});

it.effect("regression: large speech is a pinned user-readable asset and survives restart without attachment Base64", () => {
  const config = testConfig({ db: "" });
  const bytes = wav((26 * 1024 * 1024 - 44) / 2);
  const large = HttpClient.make((request) =>
    Effect.sync(() => {
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const chunk = bytes.subarray(offset, offset + 65536);
          offset += chunk.length;
          controller.enqueue(chunk);
        },
      });
      return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "audio/wav" } }));
    }),
  );
  return Effect.gen(function* () {
    const saved = yield* Effect.gen(function* () {
      yield* configured();
      const media = yield* Media;
      yield* media.createSpeech(input, { kind: "user" });
      const ready = yield* waitFor(media.get(input.id), (job) => !job.canCancel, "large speech saved");
      expect(ready.phase, ready.problem).toBe("ready");
      if (ready.kind !== "speech" || !ready.resultInput) return yield* Effect.die("Expected large speech asset");
      expect(ready.attachment).toBeUndefined();
      expect(ready).toMatchObject({
        format: "wav",
        metadata: { source: "file", sampleRate: 24000, channels: 1 },
        resultInput: { size: bytes.length, mime: "audio/wav" },
      });
      expect((yield* media.inputs.get(ready.resultInput.id)).canDelete).toBe(false);
      expect((yield* media.inputs.content(ready.resultInput.id)).size).toBe(bytes.length);
      return ready;
    }).pipe(Effect.provide(layer(generated, large, config)));
    yield* Effect.gen(function* () {
      const media = yield* Media;
      yield* media.restore();
      const media2 = yield* media.get(input.id);
      expect(media2).toEqual(saved);
      if (!saved.resultInput) return yield* Effect.die("Expected persisted large speech asset");
      expect((yield* media.inputs.content(saved.resultInput.id)).size).toBe(bytes.length);
      expect((yield* media.previewRelease(input.id)).does.length).toBeGreaterThan(0);
      expect((yield* media.inputs.get(saved.resultInput.id)).canDelete).toBe(false);
      const released = yield* media.release(input.id);
      expect(released).toMatchObject({ id: input.id, phase: "ready", resultInput: null, canRelease: false, voice: input.voice });
      const inputFailure = yield* media.inputs.get(saved.resultInput.id).pipe(Effect.flip);
      expect(inputFailure).toMatchObject({ _tag: "Refused" });
      const speechCreated = yield* media.createSpeech(input, { kind: "user" });
      expect(speechCreated).toEqual(released);
      const previewRelease2 = yield* media.previewRelease(input.id);
      expect(previewRelease2).toEqual({ does: [] });
      const released2 = yield* media.release(input.id);
      expect(released2).toEqual(released);
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() => Effect.die("Restart cannot synthesize")),
          HttpClient.make(() => Effect.die("Restart cannot download")),
          config,
        ),
      ),
    );
  });
});
