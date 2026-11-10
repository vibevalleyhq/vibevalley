import { expect, it } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import type * as T from "@vibevalley/protocol";
import { endpoints } from "@vibevalley/protocol/api";

import { Attachment } from "#/attachment/attachment.ts";
import { Channel } from "#/channel/channel.ts";
import { Db } from "#/infra/db.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import { waitFor } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import { world } from "#/testing/world.ts";
import * as input from "#db/media_input.sql.ts";
import * as q from "#db/media_job.sql.ts";

import { makeInputs } from "./inputs.ts";
import { newJob } from "./job.ts";
import { Media } from "./media.ts";
import { wav } from "./testdata/audio.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const configured = Effect.gen(function* () {
  const provider = yield* Provider;
  yield* provider.update({
    ...provider.status(),
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "release-test-key" }],
    transcription: { connection: "moss", model: "moss-transcribe-diarize-pro" },
    voiceDesign: { connection: "moss", model: "moss-voice-generator-1.0" },
  });
});
const layer = (http: HttpClient.HttpClient) =>
  Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(Layer.fresh(Provider.layer)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(
      Layer.succeed(
        PublicHttp,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(wav(), { headers: { "content-type": "audio/wav" } })))),
      ),
    ),
    Layer.provideMerge(world()),
  );
const terminal = (media: Media["Service"], id: string) => waitFor(media.get(id), (job) => !job.canCancel, "audio reached a terminal phase");

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
it.effect(
  "regression: releasing one transcript preserves another job's pins, then frees quota without replaying either generation",
  () => {
    let uploads = 0;
    let submissions = 0;
    let deletes = 0;
    const http = HttpClient.make((request) => {
      if (request.method === "DELETE") {
        deletes++;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ id: request.url.split("/").at(-1), object: "file", deleted: true })));
      }
      if (request.url.endsWith("/files")) {
        uploads++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: `file-${uploads}`,
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
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: `task-${submissions}` }, { status: 202 })));
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: request.url.split("/").at(-1),
            object: "audio.transcription",
            status: "SUCCESS",
            created_at: 1,
            updated_at: 2,
            text: "Retain this transcript.",
            segments: [{ speaker: "one", text: "Retain this transcript.", start: 0, end: 0.1 }],
          }),
        ),
      );
    });
    return Effect.gen(function* () {
      yield* configured;
      const media = yield* Media;
      const db = yield* Db;
      const bytes = wav();
      const local = yield* media.inputs.create({ kind: "audio", name: "shared.wav", mime: "audio/wav", size: bytes.length });
      yield* media.inputs.upload(local.id, Stream.make(bytes));
      const first: T.MediaTranscriptionRequest = { id: "transcript-a", connection: "moss", revision: 1, input: local.id, allowUpload: true };
      const second = { ...first, id: "transcript-b" };
      for (const request of [first, second]) {
        yield* media.createTranscription(request);
        const job = yield* terminal(media, request.id);
        expect(job.phase, job.problem).toBe("ready");
        yield* waitFor(media.get(request.id), (value) => "canCleanup" in value && !value.canCleanup, "remote file cleaned");
      }
      yield* TestClock.adjust("25 hours");
      yield* media.restore();
      expect((yield* media.inputs.content(local.id)).size).toBe(bytes.length);
      const before = yield* media.get(first.id);
      const row = yield* db.one(q.mediaJob({ id: first.id }));
      expect((yield* media.previewRelease(first.id)).does).toHaveLength(3);
      const media2 = yield* media.get(first.id);
      expect(media2).toEqual(before);
      const sql = yield* SqlClient.SqlClient;
      yield* refuse(sql, "media_input_pin_test_release", "BEFORE DELETE ON media_input_pin", "", "release blocked");
      const releasedFailure = yield* media.release(first.id).pipe(Effect.flip);
      expect(releasedFailure).toMatchObject({ _tag: "Refused" });
      const media3 = yield* media.get(first.id);
      expect(media3).toEqual(before);
      expect((yield* media.inputs.get(local.id)).canDelete).toBe(false);
      yield* allow(sql, "media_input_pin_test_release");
      const released = yield* media.release(first.id);
      expect(released).toMatchObject({ input: null, resultInput: null, previewInput: null, canRelease: false, result: { text: "Retain this transcript." } });
      const media4 = yield* media.get(second.id);
      expect(media4).toMatchObject({ input: { id: local.id }, canRelease: true });
      expect((yield* media.inputs.content(local.id)).size).toBe(bytes.length);
      const inputCapacity2 = yield* db.run(input.inputCapacity());
      expect(inputCapacity2).toEqual({ bytes: bytes.length, count: 1 });
      const after = yield* db.one(q.mediaJob({ id: first.id }));
      expect(after).toMatchObject({ request: row?.request, remote_task: row?.remote_task, result: row?.result });
      yield* media.release(second.id);
      const inputCapacity3 = yield* db.run(input.inputCapacity());
      expect(inputCapacity3).toEqual({ bytes: 0, count: 0 });
      const inputFailure = yield* media.inputs.get(local.id).pipe(Effect.flip);
      expect(inputFailure).toMatchObject({ _tag: "Refused" });
      yield* media.restore();
      const transcriptionCreated = yield* media.createTranscription(first);
      expect(transcriptionCreated).toMatchObject({ id: first.id, input: null, result: { text: "Retain this transcript." } });
      const transcriptionCreated2 = yield* media.createTranscription(second);
      expect(transcriptionCreated2).toMatchObject({ id: second.id, input: null });
      expect([uploads, submissions, deletes]).toEqual([2, 2, 2]);
    }).pipe(Effect.provide(layer(http)));
  },
  60_000,
);

it.effect("regression: releasing a design preview keeps its channel attachment and a clone's saved voice and shared source", () => {
  let generations = 0;
  let clones = 0;
  const http = HttpClient.make((request) => {
    if (request.url.endsWith("/voices")) {
      clones++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ id: "saved-voice", object: "audio.voice", name: "Warm", created_at: 1 })));
    }
    if (request.method === "POST") {
      generations++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "design-task" }, { status: 202 })));
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          id: "design-task",
          object: "audio.voice_generation",
          status: "SUCCESS",
          created_at: 1,
          updated_at: 2,
          url: "https://audio.example.com/design.wav",
          response_format: "wav",
          content_type: "audio/wav",
        }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    const request: T.MediaVoiceDesignRequest = { id: "design", connection: "moss", revision: 1, text: "Hello.", instruction: "Warm voice.", format: "wav" };
    yield* media.createVoiceDesign(request, { kind: "user" });
    const design = yield* terminal(media, request.id);
    expect(design.phase, design.problem).toBe("ready");
    if (design.kind !== "voiceDesign" || !design.previewInput || !design.attachment) return yield* Effect.die("Missing saved voice preview");
    const channel = yield* Channel;
    const published = yield* channel.post({
      _tag: "User",
      text: "Published preview",
      sendKey: "release-preview-published",
      attachments: [design.attachment.id],
    });
    const clone: T.MediaCloneRequest = { id: "clone", input: design.previewInput, connection: "moss", revision: 1, consent: true };
    yield* media.createClone(clone);
    const voice = yield* terminal(media, clone.id);
    expect(voice.phase, voice.problem).toBe("ready");
    const released = yield* media.release(design.id);
    expect(released).toMatchObject({ previewInput: null, canRelease: false, attachment: design.attachment });
    expect((yield* media.inputs.get(design.previewInput)).canDelete).toBe(false);
    const file = yield* (yield* Attachment).get(design.attachment.id);
    if (!file) return yield* Effect.die("Release deleted an independently owned channel attachment");
    const file2 = yield* (yield* FileSystem.FileSystem).readFile(file.path);
    expect(Buffer.from(file2)).toEqual(wav());
    const said = yield* channel.post({ _tag: "User", text: "Published preview", sendKey: "release-preview-published", attachments: [design.attachment.id] });
    expect(said).toMatchObject({
      again: true,
      message: published.message,
    });
    const releasedVoice = yield* media.release(clone.id);
    expect(releasedVoice).toMatchObject({ input: null, result: { kind: "clone", voice: { id: "saved-voice" } } });
    const inputFailure = yield* media.inputs.get(design.previewInput).pipe(Effect.flip);
    expect(inputFailure).toMatchObject({ _tag: "Refused" });
    const voiceDesignCreated = yield* media.createVoiceDesign(request, { kind: "user" });
    expect(voiceDesignCreated).toMatchObject({ previewInput: null });
    const cloneCreated = yield* media.createClone(clone);
    expect(cloneCreated).toEqual(releasedVoice);
    expect([generations, clones]).toEqual([1, 1]);
  }).pipe(Effect.provide(layer(http)));
});

it.effect.each(["queued", "generating", "downloading"] as const)("regression: %s audio jobs cannot release assets while local processing is active", (phase) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const media = yield* Media;
    const now = yield* Clock.currentTimeMillis;
    const request: T.MediaVoiceDesignRequest = { id: "not-terminal", connection: "moss", revision: 1, text: "Hello.", instruction: "Warm.", format: "wav" };
    yield* db.run(
      q.insertMediaJob(
        newJob({
          phase: "queued",
          id: request.id,
          kind: "voiceDesign",
          request: yield* json({ ...request, kind: "voiceDesign" }),
          source: yield* json({ kind: "user" }),
          input: null,
          connection: "moss",
          revision: 1,
          model: "moss-voice-generator-1.0",
          fingerprint: "test",
          now,
        }),
      ),
    );
    const row = yield* db.one(q.mediaJob({ id: request.id }));
    if (!row) return yield* Effect.die("Missing seeded job");
    yield* db.run(q.changeAudioJob({ ...row, phase, now }));
    const previewReleaseFailure = yield* media.previewRelease(request.id).pipe(Effect.flip);
    expect(previewReleaseFailure).toMatchObject({ _tag: "Refused" });
    const releasedFailure = yield* media.release(request.id).pipe(Effect.flip);
    expect(releasedFailure).toMatchObject({ _tag: "Refused" });
    const media2 = yield* media.get(request.id);
    expect(media2).toMatchObject({ phase, canRelease: false });
    for (const op of ["media.job.previewRelease", "media.job.release"]) expect(endpoints.find((endpoint) => endpoint.op === op)?.can).toEqual(["user"]);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Release cannot contact a provider"))))),
);

it.effect.each(["unknown", "canceled", "download_failed"] as const)(
  "regression: explicit release abandons %s audio and speech recovery without forgetting paid task IDs",
  (phase) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const media = yield* Media;
      const inputs = yield* makeInputs;
      const now = yield* Clock.currentTimeMillis;
      const design: T.MediaVoiceDesignRequest = {
        id: "abandoned-design",
        connection: "moss",
        revision: 1,
        text: "Hello.",
        instruction: "Warm.",
        format: "pcm",
      };
      const spoken: T.MediaSpeechRequest = { id: "abandoned-speech", connection: "moss", revision: 1, text: "Hello.", voice: "voice-one", format: "pcm" };
      const assets: string[] = [];
      for (const request of [design, spoken]) {
        const asset = yield* Effect.scoped(
          Effect.gen(function* () {
            const staged = yield* inputs.stageResult("result.pcm", "pcm", Stream.make(Uint8Array.of(1, 2, 3, 4)));
            return yield* inputs.storeResult(staged, request.id);
          }),
        );
        assets.push(asset.id);
        const patch = {
          phase,
          now,
          remote_task: "paid-task",
          result_url: phase === "download_failed" ? "https://audio.example.com/result.pcm" : null,
          result_input: yield* json(asset),
          result_format: "pcm" as const,
          content_type: "audio/pcm",
        };
        if ("instruction" in request) {
          yield* db.run(
            q.insertMediaJob(
              newJob({
                phase: "queued",
                id: request.id,
                kind: "voiceDesign",
                request: yield* json({ ...request, kind: "voiceDesign" }),
                source: yield* json({ kind: "user" }),
                input: null,
                connection: "moss",
                revision: 1,
                model: "moss-voice-generator-1.0",
                fingerprint: "test",
                now,
              }),
            ),
          );
          const row = yield* db.one(q.mediaJob({ id: request.id }));
          if (!row) return yield* Effect.die("Missing design job");
          yield* db.run(q.changeAudioJob({ ...row, ...patch }));
        } else {
          yield* db.run(
            q.insertMediaJob(
              newJob({
                kind: "speech",
                phase: "queued",
                id: request.id,
                request: yield* json(request),
                source: yield* json({ kind: "user" }),
                connection: "moss",
                revision: 1,
                model: "moss-tts-1.5-flash",
                credential_hash: "test",
                now,
              }),
            ),
          );
          const row = yield* db.one(q.mediaJob({ id: request.id }));
          if (!row) return yield* Effect.die("Missing speech job");
          yield* db.run(q.changeSpeechJob({ ...row, ...patch, remote_task: "paid-task" }));
        }
        const media2 = yield* media.get(request.id);
        expect(media2).toMatchObject({
          canRelease: true,
          canResume: phase !== "download_failed",
          canRetryDownload: phase === "download_failed",
        });
        expect((yield* media.previewRelease(request.id)).does).toHaveLength(3);
        expect((yield* inputs.get(asset.id)).canDelete).toBe(false);
        const released = yield* media.release(request.id);
        expect(released).toMatchObject({ phase, resultInput: null, canRelease: false, canResume: false, canRetryDownload: false });
        const downloadRetriedFailure = yield* media.retryDownload(request.id).pipe(Effect.flip);
        expect(downloadRetriedFailure).toMatchObject({ _tag: "Refused" });
      }
      const audioResumeFailure = yield* media.audioResume(design.id).pipe(Effect.flip);
      expect(audioResumeFailure).toMatchObject({ _tag: "Refused" });
      const speechResumeFailure = yield* media.speechResume(spoken.id).pipe(Effect.flip);
      expect(speechResumeFailure).toMatchObject({ _tag: "Refused" });
      const audio2 = yield* db.one(q.mediaJob({ id: design.id }));
      expect(audio2).toMatchObject({ remote_task: "paid-task", assets_released: 1 });
      const speech2 = yield* db.one(q.mediaJob({ id: spoken.id }));
      expect(speech2).toMatchObject({ remote_task: "paid-task", assets_released: 1 });
      for (const id of assets) {
        const inputFailure = yield* inputs.get(id).pipe(Effect.flip);
        expect(inputFailure).toMatchObject({ _tag: "Refused" });
      }
      yield* media.restore();
      const voiceDesignCreated = yield* media.createVoiceDesign(design, { kind: "user" });
      expect(voiceDesignCreated).toMatchObject({ phase, resultInput: null, canRelease: false });
      const speechCreated = yield* media.createSpeech(spoken, { kind: "user" });
      expect(speechCreated).toMatchObject({ phase, resultInput: null, canRelease: false });
      const inputCapacity2 = yield* db.run(input.inputCapacity());
      expect(inputCapacity2).toEqual({ bytes: 0, count: 0 });
    }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.die("Abandoned jobs cannot contact a provider"))))),
);

it.effect("regression: local release leaves failed remote deletion receipts retryable after restart", () => {
  let submissions = 0;
  let deletes = 0;
  const http = HttpClient.make((request) => {
    if (request.method === "DELETE") {
      deletes++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          deletes === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ id: "remote-file", object: "file", deleted: true }),
        ),
      );
    }
    if (request.url.endsWith("/files"))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "remote-file",
            object: "file",
            bytes: wav().length,
            created_at: 1,
            filename: "sample.wav",
            purpose: "audio",
            status: "processed",
          }),
        ),
      );
    if (request.method === "POST") {
      submissions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "remote-task" }, { status: 202 })));
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ id: "remote-task", object: "audio.transcription", status: "SUCCESS", created_at: 1, updated_at: 2, text: "Keep the transcript." }),
      ),
    );
  });
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    const local = yield* media.inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: wav().length });
    yield* media.inputs.upload(local.id, Stream.make(wav()));
    const request: T.MediaTranscriptionRequest = { id: "release-pending-cleanup", connection: "moss", revision: 1, input: local.id, allowUpload: true };
    yield* media.createTranscription(request);
    const pending = yield* waitFor(media.get(request.id), (job) => job.problem !== "", "remote cleanup recorded");
    expect(pending.phase, pending.problem).toBe("ready");
    expect(pending).toMatchObject({ canCleanup: true });
    const released = yield* media.release(request.id);
    expect(released).toMatchObject({ input: null, canCleanup: true, result: { text: "Keep the transcript." } });
    const inputFailure = yield* media.inputs.get(local.id).pipe(Effect.flip);
    expect(inputFailure).toMatchObject({ _tag: "Refused" });
    expect(deletes).toBe(1);
    yield* media.restore();
    const media2 = yield* media.get(request.id);
    expect(media2).toMatchObject({ input: null, canCleanup: false, problem: "", result: { text: "Keep the transcript." } });
    const transcriptionCreated = yield* media.createTranscription(request);
    expect(transcriptionCreated).toMatchObject({ input: null, canRelease: false });
    expect([submissions, deletes]).toEqual([1, 2]);
  }).pipe(Effect.provide(layer(http)));
});
