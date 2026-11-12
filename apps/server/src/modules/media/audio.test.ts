import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import type { PublicFetch } from "#/infra/publicHttp.ts";
import { wav } from "#/modules/media/testdata/audio.ts";
import { waitFor } from "#/testing/layers.ts";
import * as q from "#db/media_job.sql.ts";

import { audioKinds, makeAudio } from "./audio.ts";
import { makeInputs } from "./inputs.ts";
import { newJob } from "./job.ts";
import { makeMachine } from "./machine.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { downloads, hours, mediaFarm, never, vendor } from "./testing.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
async function* chunks(...parts: readonly Uint8Array[]) {
  for (const part of parts) yield part;
}

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
const download = downloads(() => new Response(wav(), { headers: { "content-type": "audio/wav" } }));

/** The audio kinds over their own machine, inputs and remote files, on a test farm whose Provider answers as http. */
const harness = async (http: typeof fetch, publicFetch: PublicFetch = download) => {
  const f = await mediaFarm({ fetch: http, publicFetch });
  await f.provider.update({
    ...f.provider.status(),
    connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "audio-private-key" }],
    speakers: { connection: "moss", model: "moss-ttsd-1.0" },
    voiceDesign: { connection: "moss", model: "moss-voice-generator-1.0" },
    transcription: { connection: "moss", model: "moss-transcribe-diarize-pro" },
  });
  const db = f.farm.db;
  const deps = { db, core: f.farm.core, clock: f.clock, log: f.log, attachment: f.farm.attachment, provider: f.provider, publicFetch };
  const inputs = makeInputs(deps);
  const remote = makeRemoteFiles(deps, inputs);
  const machine = makeMachine(deps);
  const made = makeAudio(deps, { inputs, remote, machine });
  // Another kind's job holds this id: an audio job asked with it is refused.
  if ((await q.mediaJob(db.sql, { id: "image-id" })) === undefined)
    await q.insertMediaJob(
      db.sql,
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
    );
  /** What the machine does for the audio kinds, answered as audio jobs. */
  const audio = {
    ...made,
    has: async (id: string) => {
      const row = await machine.read(id);
      return row !== undefined && audioKinds.includes(row.kind);
    },
    pending: () => machine.pending(audioKinds),
    cancel: async (id: string) => {
      await machine.cancel(id);
      return made.get(id);
    },
    retryDownload: async (id: string) => {
      await machine.retryDownload(id);
      return made.get(id);
    },
    resume: async (id: string) => {
      await machine.resume(id, audioKinds);
      return made.get(id);
    },
    restore: async () => {
      await machine.interrupt();
      await machine.pickUp();
    },
  };
  return {
    audio,
    inputs,
    db,
    provider: f.provider,
    clock: f.clock,
    adjust: f.adjust,
    another: () => makeInputs(deps),
    [Symbol.asyncDispose]: async () => {
      await machine.close();
      await f[Symbol.asyncDispose]();
    },
  };
};
const accepted = () => Response.json({ task_id: "task-one" }, { status: 202 });
const uploadedFile = (id: string) =>
  Response.json({ id, object: "file", bytes: wav().length, created_at: 1, filename: "sample.wav", purpose: "audio", status: "processed" });

test("regression: async speakers persist task ID before polling, retain actual format, and never repeat billing", async () => {
  let submitted = 0;
  let polled = 0;
  let savedRow: () => Promise<q.MediaJobResult | undefined> = async () => {
    throw new Error("Task lookup was not initialized");
  };
  const http = vendor(async (request) => {
    if (request.method === "POST") {
      submitted++;
      return accepted();
    }
    polled++;
    expect(await savedRow()).toMatchObject({ remote_task: "task-one", phase: "generating" });
    return Response.json(success);
  });
  await using h = await harness(http);
  savedRow = () => q.mediaJob(h.db.sql, { id: speakers.id });
  const { audio } = h;
  const submittedRequest = { ...speakers, format: "mp3" as const };
  await audio.createSpeakers(submittedRequest, { kind: "user" });
  const ready = await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "ready",
    "speakers saved",
  );
  expect(ready).toMatchObject({
    kind: "speakers",
    format: "wav",
    contentType: "audio/wav",
    resultInput: null,
    metadata: { source: "file", sampleRate: 24000, channels: 1 },
    attachment: { type: "audio/wav" },
  });
  expect(await audio.createSpeakers(submittedRequest, { kind: "user" })).toEqual(ready);
  expect(await failure(audio.createSpeakers({ ...submittedRequest, segments: [{ speaker: "host", text: "Changed" }] }, { kind: "user" }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  expect(await failure(audio.createSpeakers(submittedRequest, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: true }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  expect(submitted).toBe(1);
  expect(polled).toBe(1);
  notIn(ready, "signed");
  notIn(ready, "task-one");
  notIn(await q.mediaJob(h.db.sql, { id: speakers.id }), "audio-private-key");
});

test("regression: design preview is not a voice; explicit user consent clones the immutable saved sample once", async () => {
  let clones = 0;
  const http = vendor((request) => {
    if (request.url.endsWith("/voices")) {
      clones++;
      expect(request.headers.get("content-type")).toContain("multipart/form-data");
      return Response.json({ id: "saved-voice", object: "audio.voice", name: "Warm", created_at: 1 });
    }
    return request.method === "POST" ? accepted() : Response.json({ ...success, object: "audio.voice_generation" });
  });
  await using h = await harness(http);
  const { audio, inputs } = h;
  await audio.createVoiceDesign(design, { kind: "user" });
  const ready = await waitFor(
    () => audio.get(design.id),
    (job) => job.phase === "ready",
    "preview saved",
  );
  expect(ready.result).toBeNull();
  expect(clones).toBe(0);
  if (ready.previewInput === null) throw new Error("Expected retained preview input");
  expect((await inputs.get(ready.previewInput)).canDelete).toBe(false);
  const clone: T.MediaCloneRequest = {
    id: "clone-test",
    input: ready.previewInput,
    connection: ready.connection,
    revision: ready.revision,
    consent: true,
    name: "Warm",
  };
  expect(await failure(audio.createClone(clone, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: true }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  await audio.createClone(clone, { kind: "user" });
  const saved = await waitFor(
    () => audio.get(clone.id),
    (job) => job.phase === "ready",
    "voice cloned",
  );
  expect(saved.result).toEqual({ kind: "clone", voice: { id: "saved-voice", name: "Warm", createdAtSeconds: 1 } });
  expect(await audio.createClone(clone, { kind: "user" })).toEqual(saved);
  expect(clones).toBe(1);
});

test("regression: unknown submission outcomes cannot be resubmitted or resumed without a known remote ID", async () => {
  let submitted = 0;
  const http = vendor(() => {
    submitted++;
    return Response.json({ malformed: true });
  });
  await using h = await harness(http);
  const { audio } = h;
  await audio.createSpeakers(speakers, { kind: "user" });
  const unknown = await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "unknown",
    "unknown submit",
  );
  expect(unknown.canResume).toBe(false);
  expect(await audio.createSpeakers(speakers, { kind: "user" })).toEqual(unknown);
  expect(await failure(audio.resume(speakers.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await audio.restore();
  expect(submitted).toBe(1);
});

test("regression: local cancellation retains a known task; resume polls only that ID and credential rotation blocks it", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let submitted = 0;
  let ready = false;
  const http = vendor((request) => {
    if (request.method === "POST") {
      submitted++;
      return accepted();
    }
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/tasks/task-one");
    if (!ready) {
      start();
      return never(request.signal);
    }
    return Response.json(success);
  });
  await using h = await harness(http);
  const { audio, provider } = h;
  await audio.createSpeakers(speakers, { kind: "user" });
  await started;
  expect(await audio.cancel(speakers.id)).toMatchObject({ phase: "canceled", canResume: true });
  await provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "rotated" }] });
  expect(await failure(audio.resume(speakers.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "audio-private-key" }] });
  ready = true;
  await audio.resume(speakers.id);
  await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "ready",
    "same task resumed",
  );
  expect(submitted).toBe(1);
});

test("regression: restored known tasks poll the original account while queued and uncertain submissions never restart", async () => {
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer audio-private-key");
    return Response.json(success);
  });
  await using h = await harness(http);
  const { db } = h;
  for (const id of ["known", "uncertain", "queued"]) {
    await q.insertMediaJob(
      db.sql,
      newJob({
        phase: "queued",
        id,
        kind: "speakers",
        request: JSON.stringify({ ...speakers, id, kind: "speakers" }),
        source: JSON.stringify({ kind: "user" }),
        input: null,
        connection: "moss",
        revision: 1,
        model: "moss-ttsd-1.0",
        fingerprint: createHash("sha256").update("audio-private-key").digest("hex"),
        now: h.clock.now(),
      }),
    );
    if (id !== "queued") {
      const row = await q.mediaJob(db.sql, { id });
      if (!row) throw new Error("Missing seeded task");
      await q.changeMediaJob(db.sql, { ...row, phase: "generating", remote_task: id === "known" ? "task-one" : null, now: h.clock.now() });
    }
  }
  const { audio } = h;
  await audio.restore();
  await waitFor(
    () => audio.get("known"),
    (job) => job.phase === "ready",
    "known task restored",
  );
  expect((await audio.get("uncertain")).phase).toBe("unknown");
  expect((await audio.get("queued")).phase).toBe("canceled");
  expect(calls).toBe(1);
});

test("regression: shared capacity and IDs apply across audio kinds and autonomous requests are refused", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using h = await harness(http);
  const { audio } = h;
  expect(await failure(audio.createSpeakers({ ...speakers, id: "image-id" }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(audio.createSpeakers(speakers, { kind: "orchestrator", agent: "agent", channel: "", forUser: false }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  await audio.createSpeakers(speakers, { kind: "user" });
  await started;
  expect(await failure(audio.createVoiceDesign({ ...design, id: speakers.id }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let index = 0; index < 7; index++) await audio.createVoiceDesign({ ...design, id: `queued-${index}` }, { kind: "user" });
  expect(await audio.pending()).toBe(8);
  expect(await failure(audio.createVoiceDesign(design, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(1);
  await audio.cancel("queued-0");
  await audio.createVoiceDesign(design, { kind: "user" });
  expect(await audio.pending()).toBe(8);
});

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
test("regression: long transcription uploads disk-backed audio once and retains speaker timestamps and playback input", async () => {
  const operations: string[] = [];
  const http = vendor((request) => {
    operations.push(`${request.method} ${request.url}`);
    if (request.url.endsWith("/files") && request.method === "POST") {
      expect(request.headers.get("content-type")).toContain("multipart/form-data");
      return uploadedFile("file-one");
    }
    if (request.method === "DELETE") return Response.json({ id: "file-one", object: "file", deleted: true });
    if (request.method === "POST") return accepted();
    return Response.json({
      id: "task-one",
      object: "audio.transcription",
      status: "SUCCESS",
      created_at: 1,
      updated_at: 2,
      text: "Hello.",
      segments: [{ speaker: "speaker_0", text: "Hello.", start: 0, end: 0.12 }],
    });
  });
  await using h = await harness(http);
  const { audio, inputs } = h;
  const bytes = wav();
  const reserved = await inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(reserved.id, chunks(bytes.subarray(0, 11), bytes.subarray(11)));
  const request: T.MediaTranscriptionRequest = {
    id: "transcription-test",
    input: reserved.id,
    connection: "moss",
    revision: 1,
    allowUpload: true,
    diarize: true,
  };
  await audio.createTranscription(request, { kind: "user" });
  const ready = await waitFor(
    () => audio.get(request.id),
    (job) => job.phase === "ready",
    "transcription saved",
  );
  expect(ready.result).toEqual({ kind: "transcription", text: "Hello.", segments: [{ speaker: "speaker_0", text: "Hello.", start: 0, end: 0.12 }] });
  await audio.createTranscription(request, { kind: "user" });
  await waitFor(
    () => operations.filter((op) => op.startsWith("DELETE")).length,
    (count) => count === 1,
    "remote audio cleaned",
  );
  expect(operations.filter((op) => op === "POST https://api.mosi.cn/v1/audio/transcriptions")).toHaveLength(1);
  await h.adjust(hours(25));
  await inputs.sweep();
  expect((await inputs.get(reserved.id)).canDelete).toBe(false);
  expect((await inputs.content(reserved.id)).size).toBe(bytes.length);
}, 60_000);

test("regression: oversized-duration clone samples are rejected from actual audio without contacting the vendor", async () => {
  await using h = await harness(
    vendor(() => {
      throw new Error("Must not submit invalid sample");
    }),
  );
  const { audio, inputs } = h;
  const bytes = Buffer.alloc(44 + 31 * 24000 * 2);
  wav().copy(bytes, 0, 0, 44);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  const reserved = await inputs.create({ kind: "audio", name: "short-name.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(reserved.id, chunks(bytes));
  expect(
    await failure(audio.createClone({ id: "too-long", input: reserved.id, connection: "moss", revision: 1, consent: true }, { kind: "user" })),
  ).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await audio.has("too-long")).toBe(false);
  expect((await inputs.get(reserved.id)).canDelete).toBe(true);
});

test("regression: failed result downloads retry only the persisted actual format, never the paid submission", async () => {
  let submitted = 0;
  let downloaded = 0;
  const http = vendor((request) => {
    if (request.method === "POST") submitted++;
    return request.method === "POST" ? accepted() : Response.json(success);
  });
  const flakyDownload = downloads(() => {
    downloaded++;
    return downloaded === 1 ? new Response("unavailable", { status: 503 }) : new Response(wav(), { headers: { "content-type": "audio/wav" } });
  });
  await using h = await harness(http, flakyDownload);
  const { audio } = h;
  await audio.createSpeakers({ ...speakers, format: "mp3" }, { kind: "user" });
  const forWaited = await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "download_failed",
    "download paused",
  );
  expect(forWaited).toMatchObject({ canRetryDownload: true, format: "wav" });
  await audio.retryDownload(speakers.id);
  await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "ready",
    "download recovered",
  );
  await audio.retryDownload(speakers.id);
  expect(submitted).toBe(1);
  expect(downloaded).toBe(2);
});

test("regression: transient polling failures have bounded backoff and preserve the remote ID for explicit resume", async () => {
  let submitted = 0;
  let polls = 0;
  const http = vendor((request) => {
    if (request.method === "POST") {
      submitted++;
      return accepted();
    }
    polls++;
    return new Response("unavailable", { status: 503 });
  });
  await using h = await harness(http);
  const { audio } = h;
  await audio.createSpeakers(speakers, { kind: "user" });
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await waitFor(
      () => polls,
      (count) => count === index + 1,
      "poll attempt",
    );
    await h.adjust(delay);
  }
  const forWaited = await waitFor(
    () => audio.get(speakers.id),
    (job) => job.phase === "unknown",
    "polling paused",
  );
  expect(forWaited).toMatchObject({ canResume: true, canRetryDownload: false });
  expect(submitted).toBe(1);
  expect(polls).toBe(4);
});

test("regression: queued clone consent cannot upload after the account credential has changed", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using h = await harness(http);
  const { audio, inputs, provider } = h;
  await audio.createSpeakers(speakers, { kind: "user" });
  await started;
  const bytes = wav();
  const reserved = await inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(reserved.id, chunks(bytes));
  await audio.createClone({ id: "queued-clone", input: reserved.id, connection: "moss", revision: 1, consent: true }, { kind: "user" });
  await provider.update({ ...provider.status(), connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "rotated-key" }] });
  await audio.cancel(speakers.id);
  await waitFor(
    () => audio.get("queued-clone"),
    (job) => job.phase === "failed",
    "queued consent revoked",
  );
  expect(calls).toBe(1);
  await waitFor(
    () => inputs.get(reserved.id),
    (input) => input.canDelete,
    "rejected sample released",
  );
});

test("regression: explicit cleanup retries only the failed deletion and retains vendor-reported usage", async () => {
  let uploads = 0;
  let submissions = 0;
  let deletes = 0;
  const http = vendor((request) => {
    if (request.method === "DELETE") {
      deletes++;
      return deletes === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ id: "file-cleanup", object: "file", deleted: true });
    }
    if (request.url.endsWith("/files")) {
      uploads++;
      return uploadedFile("file-cleanup");
    }
    if (request.method === "POST") {
      submissions++;
      return Response.json({ task_id: "task-cleanup" }, { status: 202 });
    }
    return Response.json({
      id: "task-cleanup",
      object: "audio.transcription",
      status: "SUCCESS",
      created_at: 1,
      updated_at: 2,
      text: "Hello.",
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  await using h = await harness(http);
  const { audio, inputs } = h;
  const bytes = wav();
  const local = await inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(local.id, chunks(bytes));
  await audio.createTranscription({ id: "cleanup-test", connection: "moss", revision: 1, input: local.id, allowUpload: true }, { kind: "user" });
  const pending = await waitFor(
    () => audio.get("cleanup-test"),
    (job) => job.problem !== "" || job.phase === "failed" || job.phase === "unknown",
    "remote deletion failed",
  );
  expect(pending.phase, pending.problem).toBe("ready");
  expect(pending.canCleanup).toBe(true);
  expect(pending.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  expect((await audio.previewCleanup("cleanup-test")).does).toHaveLength(1);
  expect(deletes).toBe(1);
  const cleaned = await audio.cleanup("cleanup-test");
  expect(cleaned).toMatchObject({ phase: "ready", canCleanup: false, problem: "" });
  expect(cleaned.usage).toEqual(pending.usage);
  await audio.cleanup("cleanup-test");
  expect(uploads).toBe(1);
  expect(submissions).toBe(1);
  expect(deletes).toBe(2);
  expect((await inputs.get(local.id)).canDelete).toBe(false);
});

test("regression: unknown audio jobs refuse destructive cleanup even when an uploaded file is known", async () => {
  let deleted = false;
  const http = vendor((request) => {
    if (request.method === "DELETE") deleted = true;
    if (request.url.endsWith("/files")) return uploadedFile("file-uncertain");
    return Response.json({ malformed: true });
  });
  await using h = await harness(http);
  const { audio, inputs } = h;
  const bytes = wav();
  const local = await inputs.create({ kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(local.id, chunks(bytes));
  await audio.createTranscription({ id: "uncertain-cleanup", connection: "moss", revision: 1, input: local.id, allowUpload: true }, { kind: "user" });
  const unknown = await waitFor(
    () => audio.get("uncertain-cleanup"),
    (job) => job.phase === "unknown",
    "uncertain transcription",
  );
  expect(unknown.canCleanup).toBe(false);
  expect(unknown.usage).toBeUndefined();
  expect(await failure(audio.previewCleanup(unknown.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(audio.cleanup(unknown.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await inputs.get(local.id)).canDelete).toBe(false);
  expect(deleted).toBe(false);
});

// Real disk work on whole audio files: the slowest of the server tests when every core is busy.
test("regression: large generated WAV is pinned, playable, and retained without a channel attachment", async () => {
  const dataSize = 26 * 1024 * 1024;
  const header = wav(0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.writeUInt32LE(dataSize, 40);
  const chunk = new Uint8Array(64 * 1024);
  const large = downloads(() => {
    let sent = -1;
    return new Response(
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
    );
  });
  const http = vendor((request) => (request.method === "POST" ? accepted() : Response.json(success)));
  await using h = await harness(http, large);
  const { audio, inputs } = h;
  await audio.createSpeakers({ ...speakers, format: "mp3" }, { kind: "user" });
  const ready = await waitFor(
    () => audio.get(speakers.id),
    (job) => !job.canCancel,
    "large WAV saved",
  );
  expect(ready.phase, ready.problem).toBe("ready");
  expect(ready.attachment).toBeUndefined();
  expect(ready.usage).toBeUndefined();
  expect(ready).toMatchObject({
    format: "wav",
    metadata: { source: "file", sampleRate: 24000, channels: 1, duration: dataSize / 48000 },
    resultInput: { kind: "audio", mime: "audio/wav", size: dataSize + 44 },
  });
  if (!ready.resultInput) throw new Error("Expected large result input");
  const content = await inputs.content(ready.resultInput.id);
  expect(statSync(content.path).size).toBe(dataSize + 44);
  expect((await inputs.get(ready.resultInput.id)).canDelete).toBe(false);
  await h.adjust(hours(25));
  const restarted = h.another();
  await restarted.restore();
  await restarted.sweep();
  expect((await restarted.content(ready.resultInput.id)).size).toBe(dataSize + 44);
}, 60_000);

test.each(["done", "eof", "cancel"] as const)("streamed diarization checkpoints before %s and never resumes a lost stream", async (mode) => {
  const { promise: terminal, resolve: end } = Promise.withResolvers<void>();
  let submissions = 0;
  const sse = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  const opening = [
    { type: "task.created", task_id: "stream-task", object: "audio.transcription", status: "PROCESSING", model: "moss-transcribe-diarize-pro" },
    { type: "transcript.text.delta", delta: "Hello." },
    { type: "transcript.segment.done", content_index: 0, speaker: "S01", start: 0, end: 0.12, text: "Hello." },
    { type: "transcript.text.delta", delta: " partial" },
  ].map(sse);
  const done = sse({
    type: "transcript.text.done",
    text: "Hello. done",
    usage: { type: "duration", prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, input_audio_seconds: 0.12 },
  });
  const http = vendor((request) => {
    if (request.url.endsWith("/files") && request.method === "POST") return uploadedFile("file-stream");
    if (request.method === "DELETE") return Response.json({ id: "file-stream", object: "file", deleted: true });
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
    submissions++;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of opening) controller.enqueue(part);
        await terminal;
        if (mode === "done") controller.enqueue(done);
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  await using h = await harness(http);
  const { audio, inputs } = h;
  const bytes = wav();
  const reserved = await inputs.create({ kind: "audio", name: "stream.wav", mime: "audio/wav", size: bytes.length });
  await inputs.upload(reserved.id, chunks(bytes));
  const request: T.MediaTranscriptionRequest = {
    id: `stream-${mode}`,
    input: reserved.id,
    connection: "moss",
    revision: 1,
    allowUpload: true,
    streaming: true,
    diarize: true,
  };
  await audio.createTranscription(request, { kind: "user" });
  const partial = await waitFor(
    () => audio.get(request.id),
    (job) => job.result?.kind === "transcription" && job.result.segments.length > 0,
    "incremental speaker segment",
  );
  expect(partial.phase).toBe("generating");
  expect(partial.result).toMatchObject({ kind: "transcription", segments: [{ speaker: "S01", start: 0, end: 0.12 }] });
  if (mode === "cancel") await audio.cancel(request.id);
  else end();
  const final = await waitFor(
    () => audio.get(request.id),
    (job) => job.phase !== "generating",
    "stream terminal state",
  );
  expect(final.phase).toBe(mode === "done" ? "ready" : mode === "eof" ? "unknown" : "canceled");
  expect(final.canResume).toBe(false);
  if (mode === "done") expect(final.usage).toMatchObject({ inputAudioSeconds: 0.12, totalTokens: 5 });
  else expect(final.result).toMatchObject({ text: expect.stringContaining("Hello.") });
  expect((await inputs.get(reserved.id)).canDelete).toBe(false);
  expect((await inputs.content(reserved.id)).size).toBe(bytes.length);
  expect(await audio.createTranscription(request, { kind: "user" })).toEqual(final);
  expect(submissions).toBe(1);
  const row = await q.mediaJob(h.db.sql, { id: request.id });
  if (!row) throw new Error("Expected streamed task");
  await q.changeMediaJob(h.db.sql, { ...row, phase: "generating", now: h.clock.now() });
  await audio.restore();
  expect(await audio.get(request.id)).toMatchObject({ phase: "unknown", canResume: false, result: final.result });
  expect(submissions).toBe(1);
  end();
});
