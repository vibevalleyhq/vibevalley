import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode, endpoints } from "@vibevalley/protocol/api";

import { wav } from "#/modules/media/testdata/audio.ts";
import { waitFor } from "#/testing/layers.ts";
import * as input from "#db/media_input.sql.ts";
import * as q from "#db/media_job.sql.ts";

import { newJob } from "./job.ts";
import type { Media } from "./media.ts";
import { allow, downloads, hours, mediaFarm, refuse, vendor } from "./testing.ts";

const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
async function* chunks(...parts: readonly Uint8Array[]) {
  for (const part of parts) yield part;
}

/** A Media of its own over a test farm, bound to MOSS for transcription and voice design; results download as a WAV. */
const aMedia = async (http: typeof fetch) => {
  const f = await mediaFarm({ fetch: http, publicFetch: downloads(() => new Response(wav(), { headers: { "content-type": "audio/wav" } })) });
  await f.provider.update({
    ...f.provider.status(),
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "release-test-key" }],
    transcription: { connection: "moss", model: "moss-transcribe-diarize-pro" },
    voiceDesign: { connection: "moss", model: "moss-voice-generator-1.0" },
  });
  return f;
};
const unreachable = (why: string) =>
  vendor(() => {
    throw new Error(why);
  });
const terminal = (media: Media, id: string) =>
  waitFor(
    () => media.get(id),
    (job) => !job.canCancel,
    "audio reached a terminal phase",
  );

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
test("regression: releasing one transcript preserves another job's pins, then frees quota without replaying either generation", async () => {
  let uploads = 0;
  let submissions = 0;
  let deletes = 0;
  const http = vendor((request) => {
    if (request.method === "DELETE") {
      deletes++;
      return Response.json({ id: request.url.split("/").at(-1), object: "file", deleted: true });
    }
    if (request.url.endsWith("/files")) {
      uploads++;
      return Response.json({
        id: `file-${uploads}`,
        object: "file",
        bytes: wav().length,
        created_at: 1,
        filename: "sample.wav",
        purpose: "audio",
        status: "processed",
      });
    }
    if (request.method === "POST") {
      submissions++;
      return Response.json({ task_id: `task-${submissions}` }, { status: 202 });
    }
    return Response.json({
      id: request.url.split("/").at(-1),
      object: "audio.transcription",
      status: "SUCCESS",
      created_at: 1,
      updated_at: 2,
      text: "Retain this transcript.",
      segments: [{ speaker: "one", text: "Retain this transcript.", start: 0, end: 0.1 }],
    });
  });
  await using f = await aMedia(http);
  const { media } = f;
  const db = f.farm.db;
  const bytes = wav();
  const local = await media.inputs.create({ kind: "audio", name: "shared.wav", mime: "audio/wav", size: bytes.length });
  await media.inputs.upload(local.id, chunks(bytes));
  const first: T.MediaTranscriptionRequest = { id: "transcript-a", connection: "moss", revision: 1, input: local.id, allowUpload: true };
  const second = { ...first, id: "transcript-b" };
  for (const request of [first, second]) {
    await media.createTranscription(request);
    const job = await terminal(media, request.id);
    expect(job.phase, job.problem).toBe("ready");
    await waitFor(
      () => media.get(request.id),
      (value) => "canCleanup" in value && !value.canCleanup,
      "remote file cleaned",
    );
  }
  await f.adjust(hours(25));
  await media.start();
  expect((await media.inputs.content(local.id)).size).toBe(bytes.length);
  const before = await media.get(first.id);
  const row = await q.mediaJob(db.sql, { id: first.id });
  expect((await media.previewRelease(first.id)).does).toHaveLength(3);
  expect(await media.get(first.id)).toEqual(before);
  await refuse(db, "media_input_pin_test_release", "BEFORE DELETE ON media_input_pin", "", "release blocked");
  expect(await failure(media.release(first.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await media.get(first.id)).toEqual(before);
  expect((await media.inputs.get(local.id)).canDelete).toBe(false);
  await allow(db, "media_input_pin_test_release");
  const released = await media.release(first.id);
  expect(released).toMatchObject({ input: null, resultInput: null, previewInput: null, canRelease: false, result: { text: "Retain this transcript." } });
  expect(await media.get(second.id)).toMatchObject({ input: { id: local.id }, canRelease: true });
  expect((await media.inputs.content(local.id)).size).toBe(bytes.length);
  expect(await input.inputCapacity(db.sql)).toEqual({ bytes: bytes.length, count: 1 });
  const after = await q.mediaJob(db.sql, { id: first.id });
  expect(after).toMatchObject({ request: row?.request, remote_task: row?.remote_task, result: row?.result });
  await media.release(second.id);
  expect(await input.inputCapacity(db.sql)).toEqual({ bytes: 0, count: 0 });
  expect(await failure(media.inputs.get(local.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await media.start();
  expect(await media.createTranscription(first)).toMatchObject({ id: first.id, input: null, result: { text: "Retain this transcript." } });
  expect(await media.createTranscription(second)).toMatchObject({ id: second.id, input: null });
  expect([uploads, submissions, deletes]).toEqual([2, 2, 2]);
}, 60_000);

test("regression: releasing a design preview keeps its channel attachment and a clone's saved voice and shared source", async () => {
  let generations = 0;
  let clones = 0;
  const http = vendor((request) => {
    if (request.url.endsWith("/voices")) {
      clones++;
      return Response.json({ id: "saved-voice", object: "audio.voice", name: "Warm", created_at: 1 });
    }
    if (request.method === "POST") {
      generations++;
      return Response.json({ task_id: "design-task" }, { status: 202 });
    }
    return Response.json({
      id: "design-task",
      object: "audio.voice_generation",
      status: "SUCCESS",
      created_at: 1,
      updated_at: 2,
      url: "https://audio.example.com/design.wav",
      response_format: "wav",
      content_type: "audio/wav",
    });
  });
  await using f = await aMedia(http);
  const { media } = f;
  const request: T.MediaVoiceDesignRequest = { id: "design", connection: "moss", revision: 1, text: "Hello.", instruction: "Warm voice.", format: "wav" };
  await media.createVoiceDesign(request, { kind: "user" });
  const design = await terminal(media, request.id);
  expect(design.phase, design.problem).toBe("ready");
  if (design.kind !== "voiceDesign" || !design.previewInput || !design.attachment) throw new Error("Missing saved voice preview");
  const channel = f.farm.channel;
  const published = await channel.post({
    _tag: "User",
    text: "Published preview",
    sendKey: "release-preview-published",
    attachments: [design.attachment.id],
  });
  const clone: T.MediaCloneRequest = { id: "clone", input: design.previewInput, connection: "moss", revision: 1, consent: true };
  await media.createClone(clone);
  const voice = await terminal(media, clone.id);
  expect(voice.phase, voice.problem).toBe("ready");
  const released = await media.release(design.id);
  expect(released).toMatchObject({ previewInput: null, canRelease: false, attachment: design.attachment });
  expect((await media.inputs.get(design.previewInput)).canDelete).toBe(false);
  const file = await f.farm.attachment.get(design.attachment.id);
  if (!file) throw new Error("Release deleted an independently owned channel attachment");
  expect(readFileSync(file.path)).toEqual(wav());
  const said = await channel.post({ _tag: "User", text: "Published preview", sendKey: "release-preview-published", attachments: [design.attachment.id] });
  expect(said).toMatchObject({
    again: true,
    message: published.message,
  });
  const releasedVoice = await media.release(clone.id);
  expect(releasedVoice).toMatchObject({ input: null, result: { kind: "clone", voice: { id: "saved-voice" } } });
  expect(await failure(media.inputs.get(design.previewInput))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await media.createVoiceDesign(request, { kind: "user" })).toMatchObject({ previewInput: null });
  expect(await media.createClone(clone)).toEqual(releasedVoice);
  expect([generations, clones]).toEqual([1, 1]);
});

test.each(["queued", "generating", "downloading"] as const)(
  "regression: %s audio jobs cannot release assets while local processing is active",
  async (phase) => {
    await using f = await mediaFarm({ fetch: unreachable("Release cannot contact a provider") });
    const { media } = f;
    const db = f.farm.db;
    const now = f.clock.now();
    const request: T.MediaVoiceDesignRequest = { id: "not-terminal", connection: "moss", revision: 1, text: "Hello.", instruction: "Warm.", format: "wav" };
    await q.insertMediaJob(
      db.sql,
      newJob({
        phase: "queued",
        id: request.id,
        kind: "voiceDesign",
        request: JSON.stringify({ ...request, kind: "voiceDesign" }),
        source: JSON.stringify({ kind: "user" }),
        input: null,
        connection: "moss",
        revision: 1,
        model: "moss-voice-generator-1.0",
        fingerprint: "test",
        now,
      }),
    );
    const row = await q.mediaJob(db.sql, { id: request.id });
    if (!row) throw new Error("Missing seeded job");
    await q.changeMediaJob(db.sql, { ...row, phase, now });
    expect(await failure(media.previewRelease(request.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    expect(await failure(media.release(request.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    expect(await media.get(request.id)).toMatchObject({ phase, canRelease: false });
    for (const op of ["media.job.previewRelease", "media.job.release"]) expect(endpoints.find((endpoint) => endpoint.op === op)?.can).toEqual(["user"]);
  },
);

test.each(["unknown", "canceled", "download_failed"] as const)(
  "regression: explicit release abandons %s audio and speech recovery without forgetting paid task IDs",
  async (phase) => {
    await using f = await mediaFarm({ fetch: unreachable("Abandoned jobs cannot contact a provider") });
    const { media } = f;
    const db = f.farm.db;
    const inputs = f.inputsOf();
    const now = f.clock.now();
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
      const asset = await (async () => {
        await using staged = await inputs.stageResult("result.pcm", "pcm", chunks(Uint8Array.of(1, 2, 3, 4)));
        return await inputs.storeResult(staged, request.id);
      })();
      assets.push(asset.id);
      const patch = {
        phase,
        now,
        remote_task: "paid-task",
        result_url: phase === "download_failed" ? "https://audio.example.com/result.pcm" : null,
        result_input: JSON.stringify(asset),
        result_format: "pcm" as const,
        content_type: "audio/pcm",
      };
      if ("instruction" in request) {
        await q.insertMediaJob(
          db.sql,
          newJob({
            phase: "queued",
            id: request.id,
            kind: "voiceDesign",
            request: JSON.stringify({ ...request, kind: "voiceDesign" }),
            source: JSON.stringify({ kind: "user" }),
            input: null,
            connection: "moss",
            revision: 1,
            model: "moss-voice-generator-1.0",
            fingerprint: "test",
            now,
          }),
        );
        const row = await q.mediaJob(db.sql, { id: request.id });
        if (!row) throw new Error("Missing design job");
        await q.changeMediaJob(db.sql, { ...row, ...patch });
      } else {
        await q.insertMediaJob(
          db.sql,
          newJob({
            kind: "speech",
            phase: "queued",
            id: request.id,
            request: JSON.stringify(request),
            source: JSON.stringify({ kind: "user" }),
            connection: "moss",
            revision: 1,
            model: "moss-tts-1.5-flash",
            fingerprint: "test",
            now,
          }),
        );
        const row = await q.mediaJob(db.sql, { id: request.id });
        if (!row) throw new Error("Missing speech job");
        await q.changeMediaJob(db.sql, { ...row, ...patch, remote_task: "paid-task" });
      }
      expect(await media.get(request.id)).toMatchObject({
        canRelease: true,
        canResume: phase !== "download_failed",
        canRetryDownload: phase === "download_failed",
      });
      expect((await media.previewRelease(request.id)).does).toHaveLength(3);
      expect((await inputs.get(asset.id)).canDelete).toBe(false);
      const released = await media.release(request.id);
      expect(released).toMatchObject({ phase, resultInput: null, canRelease: false, canResume: false, canRetryDownload: false });
      expect(await failure(media.retryDownload(request.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    }
    expect(await failure(media.audioResume(design.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    expect(await failure(media.speechResume(spoken.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    expect(await q.mediaJob(db.sql, { id: design.id })).toMatchObject({ remote_task: "paid-task", assets_released: 1 });
    expect(await q.mediaJob(db.sql, { id: spoken.id })).toMatchObject({ remote_task: "paid-task", assets_released: 1 });
    for (const id of assets) expect(await failure(inputs.get(id))).toMatchObject({ bizCode: BizCode.MediaRefused });
    await media.start();
    expect(await media.createVoiceDesign(design, { kind: "user" })).toMatchObject({ phase, resultInput: null, canRelease: false });
    expect(await media.createSpeech(spoken, { kind: "user" })).toMatchObject({ phase, resultInput: null, canRelease: false });
    expect(await input.inputCapacity(db.sql)).toEqual({ bytes: 0, count: 0 });
  },
);

test("regression: local release leaves failed remote deletion receipts retryable after restart", async () => {
  let submissions = 0;
  let deletes = 0;
  const http = vendor((request) => {
    if (request.method === "DELETE") {
      deletes++;
      return deletes === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ id: "remote-file", object: "file", deleted: true });
    }
    if (request.url.endsWith("/files"))
      return Response.json({
        id: "remote-file",
        object: "file",
        bytes: wav().length,
        created_at: 1,
        filename: "sample.wav",
        purpose: "audio",
        status: "processed",
      });
    if (request.method === "POST") {
      submissions++;
      return Response.json({ task_id: "remote-task" }, { status: 202 });
    }
    return Response.json({ id: "remote-task", object: "audio.transcription", status: "SUCCESS", created_at: 1, updated_at: 2, text: "Keep the transcript." });
  });
  await using f = await aMedia(http);
  const { media } = f;
  const local = await media.inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: wav().length });
  await media.inputs.upload(local.id, chunks(wav()));
  const request: T.MediaTranscriptionRequest = { id: "release-pending-cleanup", connection: "moss", revision: 1, input: local.id, allowUpload: true };
  await media.createTranscription(request);
  const pending = await waitFor(
    () => media.get(request.id),
    (job) => job.problem !== "",
    "remote cleanup recorded",
  );
  expect(pending.phase, pending.problem).toBe("ready");
  expect(pending).toMatchObject({ canCleanup: true });
  const released = await media.release(request.id);
  expect(released).toMatchObject({ input: null, canCleanup: true, result: { text: "Keep the transcript." } });
  expect(await failure(media.inputs.get(local.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(deletes).toBe(1);
  await media.start();
  expect(await media.get(request.id)).toMatchObject({ input: null, canCleanup: false, problem: "", result: { text: "Keep the transcript." } });
  expect(await media.createTranscription(request)).toMatchObject({ input: null, canRelease: false });
  expect([submissions, deletes]).toEqual([1, 2]);
});
