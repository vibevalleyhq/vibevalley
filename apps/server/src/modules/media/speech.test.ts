import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { mp3, wav } from "#/modules/media/testdata/audio.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import * as q from "#db/media_job.sql.ts";

import { newJob } from "./job.ts";
import type { MediaCaller } from "./media.ts";
import { downloads, mediaFarm, type MediaFarmOptions, never, vendor } from "./testing.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );
const unreachable = (why: string) =>
  vendor(() => {
    throw new Error(why);
  });

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
const generated = vendor(() => Response.json(response));
const downloaded = downloads(() => new Response(wav(), { headers: { "content-type": "audio/wav" } }));
/** A Media of its own over a test farm; configured binds speech to model. */
const aMedia = async (options: MediaFarmOptions & { readonly model?: string; readonly configured?: boolean } = {}) => {
  const f = await mediaFarm({ fetch: generated, publicFetch: downloaded, ...options });
  if (options.configured !== false)
    await f.provider.update({
      revision: 0,
      connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "test-private-key" }],
      image: { connection: "moss", model: "moss-image-sft-1.0" },
      understanding: null,
      speech: { connection: "moss", model: options.model ?? "moss-tts-1.5-flash" },
      dictation: null,
      live: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
    });
  return f;
};
const seeded = (id: string, request: object, fingerprint: string) =>
  newJob({
    kind: "speech",
    phase: "queued",
    id,
    request: JSON.stringify(request),
    source: JSON.stringify({ kind: "user" }),
    connection: input.connection,
    revision: input.revision,
    model: "moss-tts-1.5-flash",
    fingerprint,
    now: 1,
  });

test.each([
  ["moss-tts-1.5-flash", "wav"],
  ["moss-tts-1.0-pro", "mp3"],
] as const)("persists the model/format pair %j once with safe state and idempotent submissions", async (model, format) => {
  let calls = 0;
  const bytes = format === "wav" ? wav() : mp3;
  const type = format === "wav" ? "audio/wav" : "audio/mpeg";
  const http = vendor(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(request.headers.get("authorization")).toBe("Bearer test-private-key");
    expect(await request.json()).toMatchObject({ model, input: input.text, voice_id: input.voice, stream: false, async: false });
    return Response.json({ ...response, response_format: format, content_type: type });
  });
  await using f = await aMedia({ model, fetch: http, publicFetch: downloads(() => new Response(bytes, { headers: { "content-type": type } })) });
  const { media } = f;
  const submitted = { ...input, format };
  expect((await media.createSpeech(submitted, { kind: "user" })).phase).toBe("queued");
  const ready = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "speech saved",
  );
  if (ready.kind !== "speech") throw new Error("Expected speech task");
  expect(ready).toMatchObject({ model, voice: input.voice, format, connection: "moss", revision: 1, source: { kind: "user" }, canCancel: false });
  expect(ready.attachment?.type).toBe(type);
  const file = await f.farm.attachment.get(ready.attachment?.id ?? "");
  if (!file) throw new Error("Expected local speech attachment");
  expect(readFileSync(file.path)).toEqual(bytes);
  const { text, ...rest } = submitted;
  expect(await media.createSpeech({ text, ...rest }, { kind: "user" })).toEqual(ready);
  for (const patch of [{ text: "Changed" }, { voice: "another-voice" }, { revision: 2 }, { format: format === "wav" ? "mp3" : "wav" }] as const) {
    expect(await failure(media.createSpeech({ ...submitted, ...patch }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect(calls).toBe(1);
  const row = await q.mediaJob(f.farm.db.sql, { id: input.id });
  expect(row?.result_url).toBeNull();
  notIn(row, "test-private-key");
  const jobs = f.farm.core.state().media;
  expect(jobs?.[0]).toMatchObject({ kind: "speech", attachment: { id: ready.attachment?.id } });
  notIn(jobs, "token=private");
});

test("regression: synchronous speech retains observed usage and actual format without changing its retry identity", async () => {
  let calls = 0;
  const usage = { inputCharacters: 13, promptTokens: 23, completionTokens: 12, totalTokens: 35 };
  const http = vendor(() => {
    calls++;
    return Response.json({ ...response, usage: { input_characters: 13, prompt_tokens: 23, completion_tokens: 12, total_tokens: 35 } });
  });
  await using f = await aMedia({ fetch: http, publicFetch: downloads(() => new Response(wav(4800), { headers: { "content-type": "audio/wav" } })) });
  const { media } = f;
  const request = { ...input, format: "mp3" as const };
  await media.createSpeech(request, { kind: "user" });
  const ready = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "actual speech format saved",
  );
  expect(ready).toMatchObject({
    format: "wav",
    contentType: "audio/wav",
    usage,
    metadata: { source: "file", sampleRate: 24000, channels: 1, bitDepth: 16, duration: 0.2 },
    attachment: { type: "audio/wav" },
  });
  expect(await media.createSpeech(request, { kind: "user" })).toEqual(ready);
  expect(calls).toBe(1);
});

test("regression: speech download starts only after the private URL is stored and retries never synthesize", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: release, resolve: releaseIt } = Promise.withResolvers<void>();
  let calls = 0;
  let downloadsMade = 0;
  const http = vendor(() => {
    calls++;
    return Response.json(response);
  });
  const download = downloads(async (request) => {
    downloadsMade++;
    expect(request.headers.get("authorization")).toBeNull();
    if (downloadsMade === 1) {
      start();
      await release;
      return new Response("broken", { status: 503 });
    }
    return new Response(wav(), { headers: { "content-type": "audio/wav" } });
  });
  await using f = await aMedia({ fetch: http, publicFetch: download });
  const { media } = f;
  await media.createSpeech(input, { kind: "user" });
  await started;
  expect(await q.mediaJob(f.farm.db.sql, { id: input.id })).toMatchObject({ phase: "downloading", result_url: response.url });
  notIn(f.farm.core.state().media, "token=private");
  releaseIt();
  expect(
    (
      await waitFor(
        () => media.get(input.id),
        (job) => job.phase === "download_failed",
        "speech download failed",
      )
    ).canRetryDownload,
  ).toBe(true);
  await media.retryDownload(input.id);
  await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "speech download retried",
  );
  await media.retryDownload(input.id);
  expect(calls).toBe(1);
  expect(downloadsMade).toBe(2);
});

test("regression: speech attachment disk failures retain the result for download-only recovery", async () => {
  const config = testConfig();
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return Response.json(response);
  });
  await using f = await aMedia({ fetch: http, config });
  const { media } = f;
  const blocked = join(config.home, "attachments");
  rmSync(blocked, { recursive: true, force: true });
  writeFileSync(blocked, "not a directory");
  await media.createSpeech(input, { kind: "user" });
  const failed = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "download_failed",
    "speech disk failure",
  );
  expect(failed.problem).not.toContain(config.home);
  rmSync(blocked);
  await media.retryDownload(input.id);
  await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "speech saved after disk repair",
  );
  expect(calls).toBe(1);
});

test("regression: queued speech freezes its selected model and credentials; stale choices cannot submit", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: release, resolve: releaseIt } = Promise.withResolvers<void>();
  const keys: (string | null)[] = [];
  const http = vendor(async (request) => {
    keys.push(request.headers.get("authorization"));
    if (keys.length === 1) {
      start();
      await release;
    }
    return Response.json(response);
  });
  await using f = await aMedia({ fetch: http });
  const { media, provider } = f;
  await media.createSpeech(input, { kind: "user" });
  await started;
  await media.createSpeech({ ...input, id: "speech-queued" }, { kind: "user" });
  const before = provider.status();
  await provider.update({
    ...before,
    connections: before.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "rotated-test-key" })),
    speech: { connection: "moss", model: "moss-tts-1.0-pro" },
  });
  expect(await failure(media.createSpeech({ ...input, id: "stale" }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  releaseIt();
  expect(
    (
      await waitFor(
        () => media.get("speech-queued"),
        (job) => job.phase === "ready",
        "frozen speech completed",
      )
    ).model,
  ).toBe("moss-tts-1.5-flash");
  await media.createSpeech({ ...input, id: "speech-fresh", revision: provider.status().revision }, { kind: "user" });
  expect(
    (
      await waitFor(
        () => media.get("speech-fresh"),
        (job) => job.phase === "ready",
        "fresh speech completed",
      )
    ).model,
  ).toBe("moss-tts-1.0-pro");
  expect(keys).toEqual(["Bearer test-private-key", "Bearer test-private-key", "Bearer rotated-test-key"]);
});

test("regression: canceling an old speech download cannot cancel its explicit retry", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: cleanup, resolve: cleanUp } = Promise.withResolvers<void>();
  let downloadsMade = 0;
  const download = downloads((request) => {
    downloadsMade++;
    if (downloadsMade === 1) {
      start();
      return never(request.signal, () => cleanup);
    }
    return new Response(wav(), { headers: { "content-type": "audio/wav" } });
  });
  await using f = await aMedia({ publicFetch: download });
  const { media } = f;
  await media.createSpeech(input, { kind: "user" });
  await started;
  const cancel = media.cancel(input.id);
  expect(
    (
      await waitFor(
        () => media.get(input.id),
        (job) => job.phase === "canceled",
        "speech waiting canceled",
      )
    ).canRetryDownload,
  ).toBe(true);
  await media.retryDownload(input.id);
  cleanUp();
  await cancel;
  await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "speech retry survives old cancellation",
  );
  expect(downloadsMade).toBe(2);
});

test("speech shares image capacity and the ID namespace without sending canceled queued tasks", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  const image: T.MediaImageRequest = { id: "shared-image", prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true };
  await media.createImage(image, { kind: "user" });
  await started;
  expect(await failure(media.createSpeech({ ...input, id: image.id }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let index = 0; index < 7; index++) await media.createSpeech({ ...input, id: `queued-${index}` }, { kind: "user" });
  expect(await failure(media.createImage({ ...image, id: "queued-0" }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(media.createSpeech(input, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let index = 0; index < 7; index++) expect((await media.cancel(`queued-${index}`)).phase).toBe("canceled");
  await media.cancel(image.id);
  expect((await media.createSpeech({ ...input, id: "queued-0" }, { kind: "user" })).phase).toBe("canceled");
  expect(calls).toBe(1);
});

test.each([400, 503])("HTTP %i speech outcomes never resubmit synthesis", async (status) => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return new Response("private upstream error", { status });
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createSpeech(input, { kind: "user" });
  const job = await waitFor(
    () => media.get(input.id),
    (row) => row.phase === (status === 400 ? "failed" : "unknown"),
    "speech failure recorded",
  );
  notIn(job, "private upstream error");
  expect(await failure(media.retryDownload(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await media.createSpeech(input, { kind: "user" });
  expect(calls).toBe(1);
});

test("regression: canceling synthesis stops local waiting without granting a synthesis retry", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  let interrupted = false;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal, async () => {
      interrupted = true;
    });
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createSpeech(input, { kind: "user" });
  await started;
  expect((await media.cancel(input.id)).phase).toBe("canceled");
  expect(interrupted).toBe(true);
  expect((await media.createSpeech(input, { kind: "user" })).phase).toBe("canceled");
  expect(await failure(media.retryDownload(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(1);
});

test("regression: stopping the service during speech submission retains uncertainty across restart", async () => {
  const config = testConfig({ db: "" });
  {
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    await using f = await aMedia({
      config,
      fetch: vendor((request) => {
        start();
        return never(request.signal);
      }),
    });
    await f.media.createSpeech(input, { kind: "user" });
    await started;
  }
  await using f = await aMedia({ config, configured: false, fetch: unreachable("Uncertain speech cannot resubmit") });
  const { media } = f;
  await media.boot();
  expect((await media.get(input.id)).phase).toBe("unknown");
  expect((await media.createSpeech(input, { kind: "user" })).phase).toBe("unknown");
  expect(await failure(media.retryDownload(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
});

test("regression: autonomous callers, invalid voices and unsupported Pro pause tags never admit speech", async () => {
  await using f = await aMedia({ model: "moss-tts-1.0-pro", fetch: unreachable("Invalid speech reached vendor") });
  const { media } = f;
  expect(await failure(media.createSpeech(input, { kind: "orchestrator", agent: "agent", channel: "channel", forUser: false }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  for (const patch of [{ voice: "../voice" }, { text: " " }, { text: "Hello [pause 1s] world" }]) {
    expect(await failure(media.createSpeech({ ...input, ...patch }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect(await media.list()).toEqual([]);
});

test("speech source and completed attachment survive restart without accepting a different caller", async () => {
  const config = testConfig({ db: "" });
  const caller: MediaCaller = { kind: "orchestrator", agent: "speech-agent", channel: "speech-channel", forUser: true };
  const source = { kind: "orchestrator", agent: "speech-agent", channel: "speech-channel" };
  const saved = await (async () => {
    await using f = await aMedia({ config });
    const { media } = f;
    await media.createSpeech(input, caller);
    const ready = await waitFor(
      () => media.get(input.id),
      (job) => job.phase === "ready",
      "attributed speech saved",
    );
    expect(ready.source).toEqual(source);
    expect((await q.mediaJob(f.farm.db.sql, { id: input.id }))?.source).toBe(JSON.stringify(source));
    return ready;
  })();
  await using f = await aMedia({ config, configured: false, fetch: unreachable("Restart cannot synthesize") });
  const { media } = f;
  await media.boot();
  expect(await media.get(input.id)).toEqual(saved);
  expect(await media.createSpeech(input, caller)).toEqual(saved);
  expect(await failure(media.createSpeech(input, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(media.createSpeech(input, { ...caller, channel: "another-channel" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(f.farm.core.state().media?.[0]?.source).toEqual(source);
});

test("restart cancels unsent speech, marks uncertainty and resumes only persisted downloads", async () => {
  await using f = await aMedia({ configured: false, fetch: unreachable("Recovery cannot synthesize") });
  const db = f.farm.db;
  for (const phase of ["queued", "generating", "downloading", "download_failed", "canceled"] as const) {
    await q.insertMediaJob(db.sql, seeded(phase, { ...input, id: phase }, ""));
    const row = await q.mediaJob(db.sql, { id: phase });
    if (row === undefined) throw new Error(`no job ${phase}`);
    await q.changeMediaJob(db.sql, {
      ...row,
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
    });
  }
  const { media } = f;
  await media.boot();
  expect((await media.get("queued")).phase).toBe("canceled");
  expect((await media.get("generating")).phase).toBe("unknown");
  await waitFor(
    () => media.get("downloading"),
    (job) => job.phase === "ready",
    "restored speech download",
  );
  for (const id of ["download_failed", "canceled"]) {
    expect((await media.get(id)).phase).toBe(id);
    await media.retryDownload(id);
    await waitFor(
      () => media.get(id),
      (job) => job.phase === "ready",
      "explicit recovered download",
    );
  }
});

// A submission takes no signal: once its job is written, the task runs whether or not the submitter stays for the answer.
test("regression: disconnecting the speech submitter cannot strand an admitted task", async () => {
  await using f = await aMedia();
  const { media } = f;
  const request = media.createSpeech(input, { kind: "user" });
  await waitFor(
    () => media.get(input.id).catch(() => undefined),
    (job) => job?.phase === "ready",
    "admitted speech outlives submitter",
  );
  expect((await request).id).toBe(input.id);
});

test("regression: asynchronous speech persists its task before polling and cancellation resumes only that task", async () => {
  const { promise: polling, resolve: poll } = Promise.withResolvers<void>();
  let submissions = 0;
  let polls = 0;
  const http = vendor((request) => {
    if (request.method === "POST") {
      submissions++;
      return Response.json({ task_id: "remote-speech" });
    }
    polls++;
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/tasks/remote-speech");
    expect(request.headers.get("authorization")).toBe("Bearer test-private-key");
    if (polls === 1) {
      poll();
      return never(request.signal);
    }
    return Response.json({ ...response, id: "remote-speech", updated_at: 2, response_format: "mp3", content_type: "audio/mpeg" });
  });
  await using f = await aMedia({ fetch: http, publicFetch: downloads(() => new Response(mp3, { headers: { "content-type": "audio/mpeg" } })) });
  const { media } = f;
  await media.createSpeech({ ...input, asynchronous: true }, { kind: "user" });
  await polling;
  expect(await q.mediaJob(f.farm.db.sql, { id: input.id })).toMatchObject({ phase: "generating", remote_task: "remote-speech" });
  expect(await media.cancel(input.id)).toMatchObject({ phase: "canceled", canResume: true });
  await media.speechResume(input.id);
  const ready = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "resumed asynchronous speech",
  );
  expect(ready).toMatchObject({ kind: "speech", format: "mp3", contentType: "audio/mpeg", metadata: { source: "file" } });
  expect(submissions).toBe(1);
  expect(polls).toBe(2);
  notIn(f.farm.core.state().media, "remote-speech");
});

test("regression: restart never queries a known asynchronous task with replaced credentials", async () => {
  await using f = await aMedia({ fetch: unreachable("Changed credentials must not reach MOSS") });
  const db = f.farm.db;
  await q.insertMediaJob(db.sql, seeded(input.id, { ...input, asynchronous: true }, "different-original-key-fingerprint"));
  const row = await q.mediaJob(db.sql, { id: input.id });
  if (!row) throw new Error("Missing seeded speech");
  await q.changeMediaJob(db.sql, { ...row, phase: "generating", remote_task: "known-before-restart", now: 2 });
  const { media } = f;
  await media.boot();
  const paused = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "unknown",
    "credential mismatch pauses polling",
  );
  expect(paused).toMatchObject({ canResume: true });
  expect(await failure(media.speechResume(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await q.mediaJob(db.sql, { id: input.id }))?.remote_task).toBe("known-before-restart");
});

test("regression: Flash delivers PCM before completion and saves actual metadata only after the terminal event", async () => {
  const { promise: first, resolve: firstHeard } = Promise.withResolvers<void>();
  const { promise: finish, resolve: finishIt } = Promise.withResolvers<void>();
  const encode = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  const pcm = wav().subarray(44);
  const http = vendor(() => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encode({ type: "task.created", task_id: "stream-private-id", object: "audio.speech", status: "PROCESSING", model: "moss-tts-1.5-flash" }),
        );
        controller.enqueue(encode({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 1, bit_depth: 16 }));
        controller.enqueue(encode({ type: "speech.audio.delta", audio: pcm.subarray(0, 1).toString("base64") }));
        controller.enqueue(encode({ type: "speech.audio.delta", audio: pcm.subarray(1).toString("base64") }));
        await finish;
        controller.enqueue(
          encode({
            type: "speech.audio.done",
            usage: { input_characters: 13, prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            meta_info: { performance: { audio_duration_s: 0.12 } },
          }),
        );
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createSpeech({ ...input, streaming: true, format: "pcm" }, { kind: "user" });
  const events: T.MediaSpeechEvent[] = [];
  const reader = (async () => {
    for await (const event of media.speechEvents(input.id)) {
      events.push(event);
      if (event.type === "audio") firstHeard();
    }
  })();
  await first;
  expect((await media.get(input.id)).phase).toBe("generating");
  expect((await q.mediaJob(f.farm.db.sql, { id: input.id }))?.remote_task).toBe("stream-private-id");
  const second = media.speechEvents(input.id)[Symbol.asyncIterator]();
  expect(await failure(second.next())).toMatchObject({ bizCode: BizCode.MediaRefused });
  finishIt();
  await reader;
  expect(events.map((event) => event.type)).toEqual(["format", "audio", "done"]);
  expect(await media.get(input.id)).toMatchObject({
    phase: "ready",
    format: "wav",
    contentType: "audio/wav",
    metadata: { source: "provider", sampleRate: 24000, channels: 1, bitDepth: 16, duration: 0.12 },
    usage: { inputCharacters: 13, promptTokens: 4, completionTokens: 2, totalTokens: 6 },
  });
  notIn(f.farm.core.state().media, "stream-private-id");
});

test("regression: EOF is not Flash completion and the received partial WAV remains available", async () => {
  const encode = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const http = vendor(
    () =>
      new Response(
        encode({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 1, bit_depth: 16 }) +
          encode({ type: "speech.audio.delta", audio: wav().subarray(44).toString("base64") }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createSpeech({ ...input, streaming: true, format: "pcm" }, { kind: "user" });
  const events: T.MediaSpeechEvent[] = [];
  for await (const event of media.speechEvents(input.id)) events.push(event);
  expect(events.some((event) => event.type === "done")).toBe(false);
  expect(await media.get(input.id)).toMatchObject({
    phase: "unknown",
    format: "wav",
    canResume: false,
    attachment: { name: `moss-${input.id}-partial.wav` },
  });
});

test("regression: large speech is a pinned user-readable asset and survives restart without attachment Base64", async () => {
  const config = testConfig({ db: "" });
  const bytes = wav((26 * 1024 * 1024 - 44) / 2);
  const large = downloads(() => {
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
    return new Response(body, { headers: { "content-type": "audio/wav" } });
  });
  const saved = await (async () => {
    await using f = await aMedia({ config, publicFetch: large });
    const { media } = f;
    await media.createSpeech(input, { kind: "user" });
    const ready = await waitFor(
      () => media.get(input.id),
      (job) => !job.canCancel,
      "large speech saved",
    );
    expect(ready.phase, ready.problem).toBe("ready");
    if (ready.kind !== "speech" || !ready.resultInput) throw new Error("Expected large speech asset");
    expect(ready.attachment).toBeUndefined();
    expect(ready).toMatchObject({
      format: "wav",
      metadata: { source: "file", sampleRate: 24000, channels: 1 },
      resultInput: { size: bytes.length, mime: "audio/wav" },
    });
    expect((await media.inputs.get(ready.resultInput.id)).canDelete).toBe(false);
    expect((await media.inputs.content(ready.resultInput.id)).size).toBe(bytes.length);
    return ready;
  })();
  await using f = await aMedia({
    config,
    configured: false,
    fetch: unreachable("Restart cannot synthesize"),
    publicFetch: downloads(() => {
      throw new Error("Restart cannot download");
    }),
  });
  const { media } = f;
  await media.boot();
  expect(await media.get(input.id)).toEqual(saved);
  if (!saved.resultInput) throw new Error("Expected persisted large speech asset");
  expect((await media.inputs.content(saved.resultInput.id)).size).toBe(bytes.length);
  expect((await media.previewRelease(input.id)).does.length).toBeGreaterThan(0);
  expect((await media.inputs.get(saved.resultInput.id)).canDelete).toBe(false);
  const released = await media.release(input.id);
  expect(released).toMatchObject({ id: input.id, phase: "ready", resultInput: null, canRelease: false, voice: input.voice });
  expect(await failure(media.inputs.get(saved.resultInput.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await media.createSpeech(input, { kind: "user" })).toEqual(released);
  expect(await media.previewRelease(input.id)).toEqual({ does: [] });
  expect(await media.release(input.id)).toEqual(released);
});
