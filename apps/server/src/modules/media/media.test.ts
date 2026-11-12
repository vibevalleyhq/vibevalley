import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { defaultOrchestrator, type MediaImageRequest } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { png } from "#/modules/media/testdata/png.ts";
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

const input: MediaImageRequest = { id: "image-test", prompt: "A quiet farm", format: "text", width: 256, height: 256, enhance: false, watermark: true };
const response = {
  created: 1,
  data: [{ url: "https://images.example.com/result.png?token=private" }],
  usage: { generated_images: 1, output_width: 256, output_height: 256 },
};
const generated = vendor(() => Response.json(response));
const downloaded = downloads(() => new Response(png(), { headers: { "content-type": "image/png" } }));

/** A Media of its own over a test farm, its provider bound to the MOSS image model. */
const aMedia = async (options: MediaFarmOptions = {}) => {
  const f = await mediaFarm({ fetch: generated, publicFetch: downloaded, ...options });
  await f.provider.update({
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
  return f;
};

test("regression: startup projects an empty generation history before the first task", async () => {
  await using f = await mediaFarm();
  await f.media.start();
  expect(f.farm.core.state().media).toEqual([]);
});

test("image tasks persist a result, keep bytes as an attachment, project safe state and deduplicate submissions", async () => {
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    expect(request.headers.get("authorization")).toBe("Bearer test-private-key");
    return Response.json(response);
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  const first = await media.createImage(input, { kind: "user" });
  expect(first.phase).toBe("queued");
  expect(first.source).toEqual({ kind: "user" });
  expect(first.usage).toBeUndefined();
  const ready = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "image saved",
  );
  if (ready.kind !== "image") throw new Error("Expected image task");
  expect(ready.attachment?.type).toBe("image/png");
  expect(ready.usage).toEqual({ images: 1, width: 256, height: 256 });
  expect(ready.canCancel).toBe(false);
  expect(await f.farm.attachment.get(ready.attachment?.id ?? "")).toBeDefined();
  const { watermark, ...rest } = input;
  expect((await media.createImage({ watermark, ...rest }, { kind: "user" })).id).toBe(input.id);
  expect(await failure(media.createImage({ ...input, prompt: "different" }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(1);
  const row = await q.mediaJob(f.farm.db.sql, { id: input.id });
  expect(row?.result_url).toBeNull();
  notIn(row, "test-private-key");
  const state = f.farm.core.state();
  expect(state.media?.[0]).toMatchObject({ kind: "image", attachment: { id: ready.attachment?.id } });
  notIn(state.media, "token=private");
});

test("download failures retry only downloads and refuse unsafe regeneration", async () => {
  let generations = 0;
  let downloadsMade = 0;
  const http = vendor(() => {
    generations++;
    return Response.json(response);
  });
  const download = downloads(() => {
    downloadsMade++;
    return downloadsMade === 1 ? new Response("bad", { status: 503 }) : new Response(png(), { headers: { "content-type": "image/png" } });
  });
  await using f = await aMedia({ fetch: http, publicFetch: download });
  const { media } = f;
  await media.createImage(input, { kind: "user" });
  const failed = await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "download_failed",
    "failed download",
  );
  if (failed.kind !== "image") throw new Error("Expected image task");
  expect(failed.canRetryDownload).toBe(true);
  expect(failed.usage).toEqual({ images: 1, width: 256, height: 256 });
  await media.retryDownload(input.id);
  await waitFor(
    () => media.get(input.id),
    (job) => job.phase === "ready",
    "download retry saved",
  );
  expect(generations).toBe(1);
  expect(downloadsMade).toBe(2);
  await media.retryDownload(input.id);
  expect(downloadsMade).toBe(2);
});

test("regression: an attachment disk failure preserves usage and retries only saving the generated result", async () => {
  const config = testConfig();
  let generations = 0;
  const http = vendor(() => {
    generations++;
    return Response.json(response);
  });
  await using f = await aMedia({ fetch: http, config });
  const { media } = f;
  const blocked = join(config.home, "attachments");
  rmSync(blocked, { recursive: true, force: true });
  writeFileSync(blocked, "not a directory");
  await media.createImage(input, { kind: "user" });
  const failed = await waitFor(
    () => media.get(input.id),
    (row) => row.phase === "download_failed",
    "disk failure recorded",
  );
  if (failed.kind !== "image") throw new Error("Expected image task");
  expect(failed.usage).toEqual({ images: 1, width: 256, height: 256 });
  expect(failed.attachment).toBeUndefined();
  expect(failed.problem).not.toContain(config.home);
  rmSync(blocked);
  await media.retryDownload(input.id);
  await waitFor(
    () => media.get(input.id),
    (row) => row.phase === "ready",
    "image saved after disk repair",
  );
  expect(generations).toBe(1);
});

test("regression: queued generations keep their account snapshot after key rotation", async () => {
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
  await media.createImage(input, { kind: "user" });
  await started;
  await media.createImage({ ...input, id: "queued-snapshot" }, { kind: "user" });
  const before = provider.status();
  await provider.update({
    ...before,
    connections: before.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "rotated-test-key" })),
  });
  releaseIt();
  await waitFor(
    () => media.get("queued-snapshot"),
    (row) => row.phase === "ready",
    "queued snapshot completed",
  );
  await media.createImage({ ...input, id: "new-snapshot" }, { kind: "user" });
  await waitFor(
    () => media.get("new-snapshot"),
    (row) => row.phase === "ready",
    "new snapshot completed",
  );
  expect(keys).toEqual(["Bearer test-private-key", "Bearer test-private-key", "Bearer rotated-test-key"]);
});

// A submission takes no signal: once its job is written, the task runs whether or not the submitter stays for the answer.
test("regression: disconnecting the submitter after persistence cannot strand an admitted task", async () => {
  let told = 0;
  await using f = await aMedia({
    core: (core) => ({
      ...core,
      apply: (...facts) => {
        if (facts.some((fact) => fact.type === "mediaChanged")) told++;
        core.apply(...facts);
      },
    }),
  });
  const { media } = f;
  const request = media.createImage(input, { kind: "user" });
  await waitFor(
    () => media.get(input.id).catch(() => undefined),
    (row) => row?.phase === "ready",
    "admitted task outlives submitter",
  );
  expect((await request).id).toBe(input.id);
  expect(told).toBeGreaterThan(0);
});

test("regression: canceling an old download cannot interrupt its explicitly started retry", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const { promise: cleanup, resolve: cleanUp } = Promise.withResolvers<void>();
  let downloadsMade = 0;
  const download = downloads((request) => {
    downloadsMade++;
    if (downloadsMade === 1) {
      start();
      return never(request.signal, () => cleanup);
    }
    return new Response(png(), { headers: { "content-type": "image/png" } });
  });
  await using f = await aMedia({ publicFetch: download });
  const { media } = f;
  await media.createImage(input, { kind: "user" });
  await started;
  const cancel = media.cancel(input.id);
  await waitFor(
    () => media.get(input.id),
    (row) => row.phase === "canceled",
    "old download canceled",
  );
  await media.retryDownload(input.id);
  cleanUp();
  await cancel;
  await waitFor(
    () => media.get(input.id),
    (row) => row.phase === "ready",
    "new download survives cancellation",
  );
  expect(downloadsMade).toBe(2);
});

test("queued cancellation, capacity and in-flight cancellation do not create more vendor requests", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createImage(input, { kind: "user" });
  await started;
  for (let n = 0; n < 7; n++) await media.createImage({ ...input, id: `queued-${n}` }, { kind: "user" });
  expect(await failure(media.createImage({ ...input, id: "overflow" }, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let n = 0; n < 7; n++) await media.cancel(`queued-${n}`);
  expect((await media.cancel(input.id)).phase).toBe("canceled");
  expect(calls).toBe(1);
  expect((await media.createImage(input, { kind: "user" })).phase).toBe("canceled");
  expect(calls).toBe(1);
});

test("ambiguous vendor failures are not retried and cannot use download retry", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return new Response("private upstream error", { status: 503 });
  });
  await using f = await aMedia({ fetch: http });
  const { media } = f;
  await media.createImage(input, { kind: "user" });
  const job = await waitFor(
    () => media.get(input.id),
    (row) => row.phase === "unknown",
    "unknown outcome",
  );
  if (job.kind !== "image") throw new Error("Expected image task");
  notIn(job, "private upstream error");
  expect(job.usage).toBeUndefined();
  expect(await failure(media.retryDownload(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await media.createImage(input, { kind: "user" });
  expect(calls).toBe(1);
});

test("generation source and reported usage survive restart without accepting a different caller", async () => {
  const config = testConfig({ db: "" });
  const caller: MediaCaller = { kind: "orchestrator", agent: "image-agent", channel: "image-channel", forUser: true };
  const source = { kind: "orchestrator", agent: "image-agent", channel: "image-channel" };
  const saved = await (async () => {
    await using f = await aMedia({ config });
    const { media } = f;
    await media.createImage(input, caller);
    const ready = await waitFor(
      () => media.get(input.id),
      (row) => row.phase === "ready",
      "attributed image saved",
    );
    if (ready.kind !== "image") throw new Error("Expected image task");
    expect(ready.source).toEqual(source);
    const row = await q.mediaJob(f.farm.db.sql, { id: input.id });
    expect(row?.source).toBe(JSON.stringify(source));
    expect(JSON.parse(row?.usage ?? "null")).toEqual(ready.usage);
    return ready;
  })();
  await using f = await mediaFarm({ fetch: generated, publicFetch: downloaded, config });
  const { media } = f;
  await media.start();
  expect(await media.get(input.id)).toEqual(saved);
  expect(await media.createImage(input, caller)).toEqual(saved);
  expect(await failure(media.createImage(input, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(media.createImage(input, { ...caller, agent: "another-agent" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(f.farm.core.state().media?.[0]?.source).toEqual(source);
});

test("regression: autonomous patrols cannot admit a billable generation", async () => {
  await using f = await aMedia({
    fetch: vendor(() => {
      throw new Error("Autonomous generation must not reach HTTP");
    }),
  });
  const { media } = f;
  expect(await failure(media.createImage(input, { kind: "orchestrator", agent: "image-agent", channel: "", forUser: false }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  expect(await media.list()).toEqual([]);
});

test("restart marks unsent and ambiguous tasks separately and resumes only stored downloads", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    throw new Error("Restart must not generate");
  });
  await using f = await mediaFarm({ fetch: http, publicFetch: downloaded });
  const db = f.farm.db;
  for (const phase of ["queued", "generating", "downloading"] as const) {
    await q.insertMediaJob(
      db.sql,
      newJob({
        kind: "image",
        phase: "queued",
        id: phase,
        request: JSON.stringify({ ...input, id: phase }),
        source: JSON.stringify({ kind: "user" }),
        connection: "moss",
        revision: 1,
        model: "moss-image-sft-1.0",
        now: 1,
      }),
    );
    const row = await q.mediaJob(db.sql, { id: phase });
    if (row === undefined) throw new Error(`no job ${phase}`);
    await q.changeMediaJob(db.sql, {
      ...row,
      id: phase,
      phase,
      attachment: null,
      usage: null,
      result_url: phase === "downloading" ? (response.data[0]?.url ?? null) : null,
      problem: "",
      now: 1,
    });
  }
  const { media } = f;
  await media.start();
  expect((await media.get("queued")).phase).toBe("canceled");
  expect((await media.get("generating")).phase).toBe("unknown");
  await waitFor(
    () => media.get("downloading"),
    (row) => row.phase === "ready",
    "restored download",
  );
  expect(calls).toBe(0);
});

describe("images asked for in a channel", () => {
  test("an image an orchestrator was asked for in a channel is posted back there under its name, once; the user's own stays", async () => {
    await using f = await aMedia();
    const { media } = f;
    const channel = f.farm.channel.defaultChannel();
    const postsOf = async (id: string) => f.farm.db.sql.query("select sender_id, meta from channel_message where send_key = $1", [`media:${id}`]);
    // One execution slot runs the tasks in turn: once the orchestrator's image is posted, the user's task is through too.
    await media.createImage({ ...input, id: "users-own" }, { kind: "user" });
    await media.createImage({ ...input, id: "asked-in-channel" }, { kind: "orchestrator", agent: defaultOrchestrator, channel, forUser: true });
    const posted = await waitFor(
      () => postsOf("asked-in-channel"),
      (rows) => rows.length > 0,
      "the image posted back",
    );
    const ready = await media.get("asked-in-channel");
    if (ready.kind !== "image") throw new Error("Expected image task");
    expect(posted).toMatchObject([{ sender_id: defaultOrchestrator }]);
    expect(String(posted[0]?.["meta"])).toContain(ready.attachment?.id ?? "missing");
    expect(await postsOf("users-own")).toEqual([]);
    // A restart posts what is ready again; the send key keeps it once.
    await media.start();
    expect(await postsOf("asked-in-channel")).toHaveLength(1);
  });
});
