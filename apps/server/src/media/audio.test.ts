import { createHash } from "node:crypto";

import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type * as T from "@vibevalley/protocol";

import { Db } from "#/infra/db.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import { waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/media_job.sql.ts";

import { audioKinds, makeAudio } from "./audio.ts";
import { makeInputs } from "./inputs.ts";
import { newJob } from "./job.ts";
import { makeMachine } from "./machine.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { wav } from "./testdata/audio.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });

const speakers: T.MediaSpeakersRequest = {
  id: "speakers-test",
  connection: "moss",
  revision: 1,
  format: "wav",
  speakers: [
    { id: "host", voice: "voice-one" },
    { id: "guest", voice: "voice-two" },
  ],
  segments: [
    { speaker: "host", text: "Hello." },
    { speaker: "guest", text: "Welcome." },
  ],
};
const design: T.MediaVoiceDesignRequest = {
  id: "design-test",
  connection: "moss",
  revision: 1,
  format: "wav",
  text: "Hello.",
  instruction: "A warm and clear voice.",
};
const success = {
  id: "task-one",
  object: "audio.speech",
  status: "SUCCESS",
  created_at: 1,
  updated_at: 2,
  url: "https://audio.example.com/result.wav?secret=signed",
  response_format: "wav",
  content_type: "audio/wav",
};
const download = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(wav(), { headers: { "content-type": "audio/wav" } }))),
);
const configured = Effect.fnUntraced(function* () {
  const provider = yield* Provider;
  yield* provider.update({
    ...provider.status(),
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "audio-private-key" }],
    speakers: { connection: "moss", model: "moss-ttsd-1.0" },
    voiceDesign: { connection: "moss", model: "moss-voice-generator-1.0" },
    transcription: { connection: "moss", model: "moss-transcribe-diarize-pro" },
  });
});
const harness = Effect.gen(function* () {
  const db = yield* Db;
  const inputs = yield* makeInputs;
  const remote = yield* makeRemoteFiles(inputs);
  const machine = yield* makeMachine;
  const made = yield* makeAudio({ inputs, remote, machine });
  // Another kind's job holds this id: an audio job asked with it is refused.
  if ((yield* db.one(q.mediaJob({ id: "image-id" }))) === undefined)
    yield* db.run(
      q.insertMediaJob(
        newJob({
          id: "image-id",
          kind: "image",
          phase: "ready",
          request: "{}",
          source: '{"kind":"user"}',
          connection: "moss",
          revision: 1,
          model: "moss-image",
          now: 0,
        }),
      ),
    );
  /** What the machine does for the audio kinds, answered as audio jobs. */
  const audio = {
    ...made,
    has: (id: string) => Effect.map(machine.read(id), (row) => row !== undefined && audioKinds.includes(row.kind)),
    pending: () => machine.pending(audioKinds),
    cancel: (id: string) => Effect.andThen(machine.cancel(id), made.get(id)),
    retryDownload: (id: string) => Effect.andThen(machine.retryDownload(id), made.get(id)),
    resume: (id: string) => Effect.andThen(machine.resume(id, audioKinds), made.get(id)),
    restore: () => Effect.andThen(machine.interrupt(), machine.pickUp()),
  };
  return { audio, inputs };
});
const layer = (http: HttpClient.HttpClient, downloads = download) =>
  // world already builds a Provider; a fresh one must capture this offline client for the account's calls.
  Layer.fresh(Provider.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, http), Layer.succeed(PublicHttp, downloads))),
    Layer.provideMerge(world()),
  );

it.effect("regression: async speakers persist task ID before polling, retain actual format, and never repeat billing", () => {
  let submitted = 0;
  let polled = 0;
  let savedRow: Effect.Effect<q.MediaJobResult | undefined> = Effect.die("Task lookup was not initialized");
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "POST") {
        submitted++;
        return HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-one" }, { status: 202 }));
      }
      polled++;
      const savedRow2 = yield* savedRow;
      expect(savedRow2).toMatchObject({ remote_task: "task-one", phase: "generating" });
      return HttpClientResponse.fromWeb(request, Response.json(success));
    }),
  );
  return Effect.gen(function* () {
    yield* configured();
    savedRow = (yield* Db).one(q.mediaJob({ id: speakers.id }));
    const { audio } = yield* harness;
    const submittedRequest = { ...speakers, format: "mp3" as const };
    yield* audio.createSpeakers(submittedRequest, { kind: "user" });
    const ready = yield* waitFor(audio.get(speakers.id), (job) => job.phase === "ready", "speakers saved");
    expect(ready).toMatchObject({
      kind: "speakers",
      format: "wav",
      contentType: "audio/wav",
      resultInput: null,
      metadata: { source: "file", sampleRate: 24000, channels: 1 },
      attachment: { type: "audio/wav" },
    });
    const speakersCreated = yield* audio.createSpeakers(submittedRequest, { kind: "user" });
    expect(speakersCreated).toEqual(ready);
    const speakersCreatedFailure = yield* audio
      .createSpeakers({ ...submittedRequest, segments: [{ speaker: "host", text: "Changed" }] }, { kind: "user" })
      .pipe(Effect.flip);
    expect(speakersCreatedFailure).toMatchObject({ _tag: "Refused" });
    const speakersCreatedFailure2 = yield* audio
      .createSpeakers(submittedRequest, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: true })
      .pipe(Effect.flip);
    expect(speakersCreatedFailure2).toMatchObject({ _tag: "Refused" });
    expect(submitted).toBe(1);
    expect(polled).toBe(1);
    yield* notIn(ready, "signed");
    yield* notIn(ready, "task-one");
    const found = yield* (yield* Db).one(q.mediaJob({ id: speakers.id }));
    yield* notIn(found, "audio-private-key");
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: design preview is not a voice; explicit user consent clones the immutable saved sample once", () => {
  let clones = 0;
  const http = HttpClient.make((request) => {
    if (request.url.endsWith("/voices")) {
      clones++;
      expect(request.body._tag).toBe("FormData");
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ id: "saved-voice", object: "audio.voice", name: "Warm", created_at: 1 })));
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.method === "POST" ? Response.json({ task_id: "task-one" }, { status: 202 }) : Response.json({ ...success, object: "audio.voice_generation" }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio, inputs } = yield* harness;
    yield* audio.createVoiceDesign(design, { kind: "user" });
    const ready = yield* waitFor(audio.get(design.id), (job) => job.phase === "ready", "preview saved");
    expect(ready.result).toBeNull();
    expect(clones).toBe(0);
    if (ready.previewInput === null) return yield* Effect.die("Expected retained preview input");
    expect((yield* inputs.get(ready.previewInput)).canDelete).toBe(false);
    const clone: T.MediaCloneRequest = {
      id: "clone-test",
      input: ready.previewInput,
      connection: ready.connection,
      revision: ready.revision,
      consent: true,
      name: "Warm",
    };
    const cloneCreatedFailure = yield* audio.createClone(clone, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: true }).pipe(Effect.flip);
    expect(cloneCreatedFailure).toMatchObject({
      _tag: "Refused",
    });
    yield* audio.createClone(clone, { kind: "user" });
    const saved = yield* waitFor(audio.get(clone.id), (job) => job.phase === "ready", "voice cloned");
    expect(saved.result).toEqual({ kind: "clone", voice: { id: "saved-voice", name: "Warm", createdAtSeconds: 1 } });
    const cloneCreated = yield* audio.createClone(clone, { kind: "user" });
    expect(cloneCreated).toEqual(saved);
    expect(clones).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: unknown submission outcomes cannot be resubmitted or resumed without a known remote ID", () => {
  let submitted = 0;
  const http = HttpClient.make((request) => {
    submitted++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ malformed: true })));
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio } = yield* harness;
    yield* audio.createSpeakers(speakers, { kind: "user" });
    const unknown = yield* waitFor(audio.get(speakers.id), (job) => job.phase === "unknown", "unknown submit");
    expect(unknown.canResume).toBe(false);
    const speakersCreated = yield* audio.createSpeakers(speakers, { kind: "user" });
    expect(speakersCreated).toEqual(unknown);
    const resumedFailure = yield* audio.resume(speakers.id).pipe(Effect.flip);
    expect(resumedFailure).toMatchObject({ _tag: "Refused" });
    yield* audio.restore();
    expect(submitted).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: local cancellation retains a known task; resume polls only that ID and credential rotation blocks it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let submitted = 0;
    let ready = false;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.method === "POST") {
          submitted++;
          return HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-one" }, { status: 202 }));
        }
        expect(request.url).toBe("https://api.mosi.cn/v1/audio/tasks/task-one");
        if (!ready) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }
        return HttpClientResponse.fromWeb(request, Response.json(success));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const { audio } = yield* harness;
      yield* audio.createSpeakers(speakers, { kind: "user" });
      yield* Deferred.await(started);
      const cancel2 = yield* audio.cancel(speakers.id);
      expect(cancel2).toMatchObject({ phase: "canceled", canResume: true });
      const provider = yield* Provider;
      yield* provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "rotated" }] });
      const resumedFailure = yield* audio.resume(speakers.id).pipe(Effect.flip);
      expect(resumedFailure).toMatchObject({ _tag: "Refused" });
      yield* provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "audio-private-key" }] });
      ready = true;
      yield* audio.resume(speakers.id);
      yield* waitFor(audio.get(speakers.id), (job) => job.phase === "ready", "same task resumed");
      expect(submitted).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer(http)));
  }),
);

it.effect("regression: restored known tasks poll the original account while queued and uncertain submissions never restart", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBe("Bearer audio-private-key");
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(success)));
  });
  return Effect.gen(function* () {
    yield* configured();
    const db = yield* Db;
    for (const id of ["known", "uncertain", "queued"]) {
      yield* db.run(
        q.insertMediaJob(
          newJob({
            phase: "queued",
            id,
            kind: "speakers",
            request: yield* json({ ...speakers, id, kind: "speakers" }),
            source: yield* json({ kind: "user" }),
            input: null,
            connection: "moss",
            revision: 1,
            model: "moss-ttsd-1.0",
            fingerprint: createHash("sha256").update("audio-private-key").digest("hex"),
            now: yield* Clock.currentTimeMillis,
          }),
        ),
      );
      if (id !== "queued") {
        const row = yield* db.one(q.mediaJob({ id }));
        if (!row) return yield* Effect.die("Missing seeded task");
        yield* db.run(q.changeMediaJob({ ...row, phase: "generating", remote_task: id === "known" ? "task-one" : null, now: yield* Clock.currentTimeMillis }));
      }
    }
    const { audio } = yield* harness;
    yield* audio.restore();
    yield* waitFor(audio.get("known"), (job) => job.phase === "ready", "known task restored");
    expect((yield* audio.get("uncertain")).phase).toBe("unknown");
    expect((yield* audio.get("queued")).phase).toBe("canceled");
    expect(calls).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: shared capacity and IDs apply across audio kinds and autonomous requests are refused", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const { audio } = yield* harness;
      const speakersCreatedFailure = yield* audio.createSpeakers({ ...speakers, id: "image-id" }, { kind: "user" }).pipe(Effect.flip);
      expect(speakersCreatedFailure).toMatchObject({ _tag: "Refused" });
      const speakersCreatedFailure2 = yield* audio
        .createSpeakers(speakers, { kind: "orchestrator", agent: "agent", channel: "", forUser: false })
        .pipe(Effect.flip);
      expect(speakersCreatedFailure2).toMatchObject({
        _tag: "Refused",
      });
      yield* audio.createSpeakers(speakers, { kind: "user" });
      yield* Deferred.await(started);
      const voiceDesignCreatedFailure = yield* audio.createVoiceDesign({ ...design, id: speakers.id }, { kind: "user" }).pipe(Effect.flip);
      expect(voiceDesignCreatedFailure).toMatchObject({ _tag: "Refused" });
      for (let index = 0; index < 7; index++) yield* audio.createVoiceDesign({ ...design, id: `queued-${index}` }, { kind: "user" });
      const pending2 = yield* audio.pending();
      expect(pending2).toBe(8);
      const voiceDesignCreatedFailure2 = yield* audio.createVoiceDesign(design, { kind: "user" }).pipe(Effect.flip);
      expect(voiceDesignCreatedFailure2).toMatchObject({ _tag: "Refused" });
      expect(calls).toBe(1);
      yield* audio.cancel("queued-0");
      yield* audio.createVoiceDesign(design, { kind: "user" });
      const pending3 = yield* audio.pending();
      expect(pending3).toBe(8);
    }).pipe(Effect.scoped, Effect.provide(layer(http)));
  }),
);

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
it.effect(
  "regression: long transcription uploads disk-backed audio once and retains speaker timestamps and playback input",
  () => {
    const operations: string[] = [];
    const http = HttpClient.make((request) => {
      operations.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/files") && request.method === "POST") {
        expect(request.body._tag).toBe("FormData");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: "file-one",
              object: "file",
              bytes: wav().length,
              created_at: 1,
              filename: "sample.wav",
              purpose: "audio",
              status: "processed",
            }),
          ),
        );
      }
      if (request.method === "DELETE")
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ id: "file-one", object: "file", deleted: true })));
      if (request.method === "POST") return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-one" }, { status: 202 })));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "task-one",
            object: "audio.transcription",
            status: "SUCCESS",
            created_at: 1,
            updated_at: 2,
            text: "Hello.",
            segments: [{ speaker: "speaker_0", text: "Hello.", start: 0, end: 0.12 }],
          }),
        ),
      );
    });
    return Effect.gen(function* () {
      yield* configured();
      const { audio, inputs } = yield* harness;
      const bytes = wav();
      const reserved = yield* inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
      yield* inputs.upload(reserved.id, Stream.make(bytes.subarray(0, 11), bytes.subarray(11)));
      const request: T.MediaTranscriptionRequest = {
        id: "transcription-test",
        input: reserved.id,
        connection: "moss",
        revision: 1,
        allowUpload: true,
        diarize: true,
      };
      yield* audio.createTranscription(request, { kind: "user" });
      const ready = yield* waitFor(audio.get(request.id), (job) => job.phase === "ready", "transcription saved");
      expect(ready.result).toEqual({ kind: "transcription", text: "Hello.", segments: [{ speaker: "speaker_0", text: "Hello.", start: 0, end: 0.12 }] });
      yield* audio.createTranscription(request, { kind: "user" });
      yield* waitFor(
        Effect.sync(() => operations.filter((op) => op.startsWith("DELETE")).length),
        (count) => count === 1,
        "remote audio cleaned",
      );
      expect(operations.filter((op) => op === "POST https://api.mosi.cn/v1/audio/transcriptions")).toHaveLength(1);
      yield* TestClock.adjust("25 hours");
      yield* inputs.sweep();
      expect((yield* inputs.get(reserved.id)).canDelete).toBe(false);
      expect((yield* inputs.content(reserved.id)).size).toBe(bytes.length);
    }).pipe(Effect.scoped, Effect.provide(layer(http)));
  },
  60_000,
);

it.effect("regression: oversized-duration clone samples are rejected from actual audio without contacting the vendor", () =>
  Effect.gen(function* () {
    yield* configured();
    const { audio, inputs } = yield* harness;
    const bytes = Buffer.alloc(44 + 31 * 24000 * 2);
    wav().copy(bytes, 0, 0, 44);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const reserved = yield* inputs.create({ kind: "audio", name: "short-name.wav", mime: "audio/wav", size: bytes.length });
    yield* inputs.upload(reserved.id, Stream.make(bytes));
    const cloneCreatedFailure = yield* audio
      .createClone({ id: "too-long", input: reserved.id, connection: "moss", revision: 1, consent: true }, { kind: "user" })
      .pipe(Effect.flip);
    expect(cloneCreatedFailure).toMatchObject({ _tag: "Refused" });
    const has2 = yield* audio.has("too-long");
    expect(has2).toBe(false);
    expect((yield* inputs.get(reserved.id)).canDelete).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer(HttpClient.make(() => Effect.die("Must not submit invalid sample"))))),
);

it.effect("regression: failed result downloads retry only the persisted actual format, never the paid submission", () => {
  let submitted = 0;
  let downloaded = 0;
  const http = HttpClient.make((request) => {
    if (request.method === "POST") submitted++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, request.method === "POST" ? Response.json({ task_id: "task-one" }, { status: 202 }) : Response.json(success)),
    );
  });
  const flakyDownload = HttpClient.make((request) => {
    downloaded++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        downloaded === 1 ? new Response("unavailable", { status: 503 }) : new Response(wav(), { headers: { "content-type": "audio/wav" } }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio } = yield* harness;
    yield* audio.createSpeakers({ ...speakers, format: "mp3" }, { kind: "user" });
    const forWaited = yield* waitFor(audio.get(speakers.id), (job) => job.phase === "download_failed", "download paused");
    expect(forWaited).toMatchObject({
      canRetryDownload: true,
      format: "wav",
    });
    yield* audio.retryDownload(speakers.id);
    yield* waitFor(audio.get(speakers.id), (job) => job.phase === "ready", "download recovered");
    yield* audio.retryDownload(speakers.id);
    expect(submitted).toBe(1);
    expect(downloaded).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(layer(http, flakyDownload)));
});

it.effect("regression: transient polling failures have bounded backoff and preserve the remote ID for explicit resume", () => {
  let submitted = 0;
  let polls = 0;
  const http = HttpClient.make((request) => {
    if (request.method === "POST") {
      submitted++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-one" }, { status: 202 })));
    }
    polls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })));
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio } = yield* harness;
    yield* audio.createSpeakers(speakers, { kind: "user" });
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      yield* waitFor(
        Effect.sync(() => polls),
        (count) => count === index + 1,
        "poll attempt",
      );
      yield* TestClock.adjust(delay);
    }
    const forWaited = yield* waitFor(audio.get(speakers.id), (job) => job.phase === "unknown", "polling paused");
    expect(forWaited).toMatchObject({
      canResume: true,
      canRetryDownload: false,
    });
    expect(submitted).toBe(1);
    expect(polls).toBe(4);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: queued clone consent cannot upload after the account credential has changed", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const { audio, inputs } = yield* harness;
      yield* audio.createSpeakers(speakers, { kind: "user" });
      yield* Deferred.await(started);
      const bytes = wav();
      const reserved = yield* inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
      yield* inputs.upload(reserved.id, Stream.make(bytes));
      yield* audio.createClone({ id: "queued-clone", input: reserved.id, connection: "moss", revision: 1, consent: true }, { kind: "user" });
      const provider = yield* Provider;
      yield* provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "rotated-key" }] });
      yield* audio.cancel(speakers.id);
      yield* waitFor(audio.get("queued-clone"), (job) => job.phase === "failed", "queued consent revoked");
      expect(calls).toBe(1);
      yield* waitFor(inputs.get(reserved.id), (input) => input.canDelete, "rejected sample released");
    }).pipe(Effect.scoped, Effect.provide(layer(http)));
  }),
);

it.effect("regression: explicit cleanup retries only the failed deletion and retains vendor-reported usage", () => {
  let uploads = 0;
  let submissions = 0;
  let deletes = 0;
  const http = HttpClient.make((request) => {
    if (request.method === "DELETE") {
      deletes++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          deletes === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ id: "file-cleanup", object: "file", deleted: true }),
        ),
      );
    }
    if (request.url.endsWith("/files")) {
      uploads++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "file-cleanup",
            object: "file",
            bytes: wav().length,
            created_at: 1,
            filename: "sample.wav",
            purpose: "audio",
            status: "processed",
          }),
        ),
      );
    }
    if (request.method === "POST") {
      submissions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-cleanup" }, { status: 202 })));
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          id: "task-cleanup",
          object: "audio.transcription",
          status: "SUCCESS",
          created_at: 1,
          updated_at: 2,
          text: "Hello.",
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio, inputs } = yield* harness;
    const bytes = wav();
    const local = yield* inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
    yield* inputs.upload(local.id, Stream.make(bytes));
    yield* audio.createTranscription({ id: "cleanup-test", connection: "moss", revision: 1, input: local.id, allowUpload: true }, { kind: "user" });
    const pending = yield* waitFor(
      audio.get("cleanup-test"),
      (job) => job.problem !== "" || job.phase === "failed" || job.phase === "unknown",
      "remote deletion failed",
    );
    expect(pending.phase, pending.problem).toBe("ready");
    expect(pending.canCleanup).toBe(true);
    expect(pending.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    expect((yield* audio.previewCleanup("cleanup-test")).does).toHaveLength(1);
    expect(deletes).toBe(1);
    const cleaned = yield* audio.cleanup("cleanup-test");
    expect(cleaned).toMatchObject({ phase: "ready", canCleanup: false, problem: "" });
    expect(cleaned.usage).toEqual(pending.usage);
    yield* audio.cleanup("cleanup-test");
    expect(uploads).toBe(1);
    expect(submissions).toBe(1);
    expect(deletes).toBe(2);
    expect((yield* inputs.get(local.id)).canDelete).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

it.effect("regression: unknown audio jobs refuse destructive cleanup even when an uploaded file is known", () => {
  let deleted = false;
  const http = HttpClient.make((request) => {
    if (request.method === "DELETE") deleted = true;
    if (request.url.endsWith("/files"))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "file-uncertain",
            object: "file",
            bytes: wav().length,
            created_at: 1,
            filename: "sample.wav",
            purpose: "audio",
            status: "processed",
          }),
        ),
      );
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ malformed: true })));
  });
  return Effect.gen(function* () {
    yield* configured();
    const { audio, inputs } = yield* harness;
    const bytes = wav();
    const local = yield* inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
    yield* inputs.upload(local.id, Stream.make(bytes));
    yield* audio.createTranscription({ id: "uncertain-cleanup", connection: "moss", revision: 1, input: local.id, allowUpload: true }, { kind: "user" });
    const unknown = yield* waitFor(audio.get("uncertain-cleanup"), (job) => job.phase === "unknown", "uncertain transcription");
    expect(unknown.canCleanup).toBe(false);
    expect(unknown.usage).toBeUndefined();
    const previewCleanupFailure = yield* audio.previewCleanup(unknown.id).pipe(Effect.flip);
    expect(previewCleanupFailure).toMatchObject({ _tag: "Refused" });
    const cleanupFailure = yield* audio.cleanup(unknown.id).pipe(Effect.flip);
    expect(cleanupFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* inputs.get(local.id)).canDelete).toBe(false);
    expect(deleted).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer(http)));
});

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
it.effect(
  "regression: large generated WAV is pinned, playable, and retained without a channel attachment",
  () => {
    const dataSize = 26 * 1024 * 1024;
    const header = wav(0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.writeUInt32LE(dataSize, 40);
    const chunk = new Uint8Array(64 * 1024);
    const downloads = HttpClient.make((request) => {
      let sent = -1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent < 0) {
                  controller.enqueue(header);
                  sent = 0;
                } else if (sent < dataSize) {
                  controller.enqueue(chunk);
                  sent += chunk.byteLength;
                } else controller.close();
              },
            }),
            { headers: { "content-type": "audio/wav" } },
          ),
        ),
      );
    });
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, request.method === "POST" ? Response.json({ task_id: "task-one" }, { status: 202 }) : Response.json(success)),
      ),
    );
    return Effect.gen(function* () {
      yield* configured();
      const { audio, inputs } = yield* harness;
      yield* audio.createSpeakers({ ...speakers, format: "mp3" }, { kind: "user" });
      const ready = yield* waitFor(audio.get(speakers.id), (job) => !job.canCancel, "large WAV saved");
      expect(ready.phase, ready.problem).toBe("ready");
      expect(ready.attachment).toBeUndefined();
      expect(ready.usage).toBeUndefined();
      expect(ready).toMatchObject({
        format: "wav",
        metadata: { source: "file", sampleRate: 24000, channels: 1, duration: dataSize / 48000 },
        resultInput: { kind: "audio", mime: "audio/wav", size: dataSize + 44 },
      });
      if (!ready.resultInput) return yield* Effect.die("Expected large result input");
      const content = yield* inputs.content(ready.resultInput.id);
      expect(Number((yield* (yield* FileSystem.FileSystem).stat(content.path)).size)).toBe(dataSize + 44);
      expect((yield* inputs.get(ready.resultInput.id)).canDelete).toBe(false);
      yield* TestClock.adjust("25 hours");
      const restarted = yield* makeInputs;
      yield* restarted.restore();
      yield* restarted.sweep();
      expect((yield* restarted.content(ready.resultInput.id)).size).toBe(dataSize + 44);
    }).pipe(Effect.scoped, Effect.provide(layer(http, downloads)));
  },
  60_000,
);

it.effect.each(["done", "eof", "cancel"] as const)("streamed diarization checkpoints before %s and never resumes a lost stream", (mode) =>
  Effect.gen(function* () {
    const terminal = yield* Deferred.make<void>();
    let submissions = 0;
    const sse = (event: object) => json(event).pipe(Effect.map((text) => new TextEncoder().encode(`data: ${text}\n\n`)));
    const opening = yield* Effect.forEach(
      [
        { type: "task.created", task_id: "stream-task", object: "audio.transcription", status: "PROCESSING", model: "moss-transcribe-diarize-pro" },
        { type: "transcript.text.delta", delta: "Hello." },
        { type: "transcript.segment.done", content_index: 0, speaker: "S01", start: 0, end: 0.12, text: "Hello." },
        { type: "transcript.text.delta", delta: " partial" },
      ],
      sse,
    );
    const done = yield* sse({
      type: "transcript.text.done",
      text: "Hello. done",
      usage: { type: "duration", prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, input_audio_seconds: 0.12 },
    });
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url.endsWith("/files") && request.method === "POST")
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: "file-stream",
              object: "file",
              bytes: wav().length,
              created_at: 1,
              filename: "sample.wav",
              purpose: "audio",
              status: "processed",
            }),
          );
        if (request.method === "DELETE") return HttpClientResponse.fromWeb(request, Response.json({ id: "file-stream", object: "file", deleted: true }));
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
        submissions++;
        const first = Stream.fromIterable(opening);
        const last = Stream.fromEffect(Deferred.await(terminal).pipe(Effect.as(mode === "done" ? done : new Uint8Array(0))));
        const body = yield* Stream.toReadableStreamEffect(Stream.concat(first, last));
        return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }),
    );
    yield* Effect.gen(function* () {
      yield* configured();
      const { audio, inputs } = yield* harness;
      const bytes = wav();
      const reserved = yield* inputs.create({ kind: "audio", name: "stream.wav", mime: "audio/wav", size: bytes.length });
      yield* inputs.upload(reserved.id, Stream.make(bytes));
      const request: T.MediaTranscriptionRequest = {
        id: `stream-${mode}`,
        input: reserved.id,
        connection: "moss",
        revision: 1,
        allowUpload: true,
        streaming: true,
        diarize: true,
      };
      yield* audio.createTranscription(request, { kind: "user" });
      const partial = yield* waitFor(
        audio.get(request.id),
        (job) => job.result?.kind === "transcription" && job.result.segments.length > 0,
        "incremental speaker segment",
      );
      expect(partial.phase).toBe("generating");
      expect(partial.result).toMatchObject({ kind: "transcription", segments: [{ speaker: "S01", start: 0, end: 0.12 }] });
      if (mode === "cancel") yield* audio.cancel(request.id);
      else yield* Deferred.succeed(terminal, undefined);
      const final = yield* waitFor(audio.get(request.id), (job) => job.phase !== "generating", "stream terminal state");
      expect(final.phase).toBe(mode === "done" ? "ready" : mode === "eof" ? "unknown" : "canceled");
      expect(final.canResume).toBe(false);
      if (mode === "done") expect(final.usage).toMatchObject({ inputAudioSeconds: 0.12, totalTokens: 5 });
      else expect(final.result).toMatchObject({ text: expect.stringContaining("Hello.") });
      expect((yield* inputs.get(reserved.id)).canDelete).toBe(false);
      expect((yield* inputs.content(reserved.id)).size).toBe(bytes.length);
      const transcriptionCreated = yield* audio.createTranscription(request, { kind: "user" });
      expect(transcriptionCreated).toEqual(final);
      expect(submissions).toBe(1);
      const row = yield* (yield* Db).one(q.mediaJob({ id: request.id }));
      if (!row) return yield* Effect.die("Expected streamed task");
      yield* (yield* Db).run(q.changeMediaJob({ ...row, phase: "generating", now: yield* Clock.currentTimeMillis }));
      yield* audio.restore();
      const audio2 = yield* audio.get(request.id);
      expect(audio2).toMatchObject({ phase: "unknown", canResume: false, result: final.result });
      expect(submissions).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer(http)));
  }),
);
