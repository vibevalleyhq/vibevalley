import { expect, test } from "vite-plus/test";

import type { MediaUnderstandingRequest } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { png } from "#/modules/media/testdata/png.ts";
import { waitFor } from "#/testing/layers.ts";
import * as q from "#db/media_job.sql.ts";

import { newJob } from "./job.ts";
import { mediaFarm, minutes, never, vendor } from "./testing.ts";

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

const bytes = png();
const result = {
  id: "response-one",
  model: "moss-vl-1.0-2026-07-08",
  status: "completed",
  output: [{ content: [{ type: "output_text", text: "A synthetic green square." }] }],
  usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
};
const reply = (request: Request, response = result) => {
  if (request.method === "DELETE") return Response.json({ id: "file-one", object: "file", deleted: true });
  if (request.url.endsWith("/files"))
    return Response.json({
      id: "file-one",
      object: "file",
      bytes: bytes.length,
      created_at: 1,
      filename: "accepted.png",
      purpose: "image",
      status: "processed",
    });
  return Response.json(response);
};
/** A Media of its own over a test farm, bound to MOSS for images and understanding, with one image input the user uploaded. */
const fixture = async (http: typeof fetch) => {
  const f = await mediaFarm({ fetch: http });
  const status = await f.provider.update({
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
  const { media } = f;
  const input = await media.inputs.create({ kind: "image", mime: "image/png", name: "private-user-image.png", size: bytes.length });
  await media.inputs.upload(input.id, chunks(bytes));
  const request: MediaUnderstandingRequest = {
    id: "understanding-one",
    prompt: "Describe this synthetic image.",
    inputs: [input.id],
    connection: "moss",
    revision: status.revision,
    allowUpload: true,
    maxOutputTokens: 64,
  };
  return Object.assign(f, { input, request });
};
const unreachable = (why: string) =>
  vendor(() => {
    throw new Error(why);
  });
const hanging = vendor((request) => never(request.signal));

test.each(["completed", "incomplete"])("understanding persists %s text and actual usage, projects it, cleans files, and deduplicates", async (status) => {
  const calls: string[] = [];
  const http = vendor(async (request) => {
    calls.push(`${request.method} ${request.url}`);
    expect(request.headers.get("authorization")).toBe("Bearer test-only-understanding-key");
    if (request.url.endsWith("/files")) {
      // oxlint-disable-next-line typescript/no-deprecated -- a test reading back the multipart body the vendor would get
      const file = (await request.clone().formData()).get("file");
      if (!(file instanceof File)) throw new Error("Expected file");
      expect(file.name).not.toContain("private-user");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    }
    if (request.url.endsWith("/responses")) {
      expect(await request.clone().json()).toEqual({
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
      });
    }
    return reply(request, { ...result, status });
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  expect((await media.createUnderstanding(request)).phase).toBe("queued");
  const job = await waitFor(
    () => media.get(request.id),
    (row) => row.kind === "understanding" && row.cleanup === "done",
    "understanding and cleanup complete",
  );
  if (job.kind !== "understanding") throw new Error("Expected understanding");
  expect(job.phase).toBe(status === "completed" ? "ready" : "incomplete");
  expect(job.result).toEqual({
    model: result.model,
    text: result.output[0]?.content[0]?.text,
    status,
    incompleteReason: null,
    usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
  });
  expect(job.inputs[0]).toMatchObject({ id: input.id, name: input.name });
  expect(f.farm.core.state().media).toEqual([job]);
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
  expect(await media.createUnderstanding(request)).toEqual(job);
  expect(await media.cleanupUnderstanding(request.id)).toEqual(job);
  expect(calls).toEqual(["POST https://api.mosi.cn/v1/files", "POST https://api.mosi.cn/v1/responses", "DELETE https://api.mosi.cn/v1/files/file-one"]);
  notIn(job, "test-only-understanding-key");
  notIn(await q.mediaJob(f.farm.db.sql, { id: request.id }), "test-only-understanding-key");
  expect(await failure(media.createUnderstanding({ ...request, prompt: "Different question" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
});

test("regression: stale consent and an image task ID cannot submit an understanding request", async () => {
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    return never(request.signal);
  });
  await using f = await fixture(http);
  const { media, request } = f;
  expect(await failure(media.createUnderstanding({ ...request, revision: 0 }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toBe(0);
  await media.createImage({ id: request.id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true }, { kind: "user" });
  expect(await failure(media.createUnderstanding(request))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await media.cancel(request.id);
});

test("regression: shared history uses the same binary ID order as SQLite for tied timestamps", async () => {
  await using f = await fixture(hanging);
  const { media, request } = f;
  const image = await media.createImage(
    { id: "a-image", prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true },
    { kind: "user" },
  );
  const understanding = await media.createUnderstanding({ ...request, id: "Z-understanding" });
  expect(image.createdAt).toBe(understanding.createdAt);
  expect((await media.list()).map((job) => job.id)).toEqual(["Z-understanding", "a-image"]);
  await media.cancel(understanding.id);
  await media.cancel(image.id);
});

test("invalid input references, mixed media and bounds fail before retention or vendor calls", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    throw new Error("Invalid input must not contact the provider");
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  const header = Buffer.alloc(32);
  header.write("ftyp", 4);
  const video = await media.inputs.create({ kind: "video", name: "container-header.mp4", mime: "video/mp4", size: header.length });
  await media.inputs.upload(video.id, chunks(header));
  for (const invalid of [
    { ...request, inputs: ["/etc/passwd"] },
    { ...request, inputs: [input.id, input.id] },
    { ...request, inputs: [input.id, video.id] },
    { ...request, maxOutputTokens: 0 },
    { ...request, inputs: Array.from({ length: 6 }, (_, n) => `input-${n}`) },
  ]) {
    expect(await failure(media.createUnderstanding(invalid))).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect(calls).toBe(0);
  expect(await media.list()).toEqual([]);
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
  expect((await media.inputs.get(video.id)).canDelete).toBe(true);
});

test("unknown inference is not repeated and retains files until explicit cleanup", async () => {
  const calls: string[] = [];
  const http = vendor((request) => {
    calls.push(request.url);
    return request.url.endsWith("/responses") ? Response.json({ private: "vendor diagnostic" }, { status: 503 }) : reply(request);
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  await media.createUnderstanding(request);
  const job = await waitFor(
    () => media.get(request.id),
    (row) => row.phase === "unknown",
    "unknown inference",
  );
  expect(job.problem).not.toContain("vendor diagnostic");
  expect((await media.inputs.get(input.id)).canDelete).toBe(false);
  expect((await media.createUnderstanding(request)).phase).toBe("unknown");
  expect(calls).toHaveLength(2);
  expect((await media.previewUnderstandingCleanup(request.id)).does).toHaveLength(2);
  expect(calls).toHaveLength(2);
  expect((await media.inputs.get(input.id)).canDelete).toBe(false);
  expect((await media.cleanupUnderstanding(request.id)).cleanup).toBe("done");
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
  expect(calls.filter((url) => url.endsWith("/responses"))).toHaveLength(1);
});

test("regression: unknown uploads never trigger inference or blind account cleanup", async () => {
  let calls = 0;
  const http = vendor(() => {
    calls++;
    return Response.json({}, { status: 503 });
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  await media.createUnderstanding(request);
  await waitFor(
    () => media.get(request.id),
    (row) => row.phase === "unknown",
    "unknown upload",
  );
  const cleaned = await media.cleanupUnderstanding(request.id);
  expect(cleaned.cleanup).toBe("unknown");
  expect(cleaned.problem).toContain("vv-");
  expect(cleaned.canCleanup).toBe(false);
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
  await media.createUnderstanding(request);
  expect(calls).toBe(1);
});

test("cleanup retries only deletion and refuses changed credentials without losing the result", async () => {
  let deletion = 503;
  const calls: string[] = [];
  const http = vendor((request) => {
    calls.push(request.method);
    return request.method === "DELETE" ? Response.json({}, { status: deletion }) : reply(request);
  });
  await using f = await fixture(http);
  const { media, request, provider } = f;
  await media.createUnderstanding(request);
  await waitFor(
    () => media.get(request.id),
    (row) => row.kind === "understanding" && row.cleanup === "blocked",
    "cleanup failure",
  );
  const status = provider.status();
  await provider.update({ ...status, connections: status.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "replacement-key" })) });
  expect((await media.cleanupUnderstanding(request.id)).cleanup).toBe("blocked");
  expect(calls).toEqual(["POST", "POST", "DELETE"]);
  const changed = provider.status();
  await provider.update({
    ...changed,
    connections: changed.connections.map(({ key: _key, ...connection }) => ({ ...connection, key: "test-only-understanding-key" })),
  });
  deletion = 404;
  const cleaned = await media.cleanupUnderstanding(request.id);
  expect(cleaned.cleanup).toBe("done");
  expect(cleaned.result?.text).toBe("A synthetic green square.");
  expect(calls).toEqual(["POST", "POST", "DELETE", "DELETE"]);
});

test("image and understanding tasks share capacity, IDs and cancellation without resubmission", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let calls = 0;
  const http = vendor((request) => {
    calls++;
    start();
    return never(request.signal);
  });
  await using f = await fixture(http);
  const { media, request } = f;
  await media.createUnderstanding(request);
  await started;
  const image = { id: request.id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true } as const;
  expect(await failure(media.createImage(image, { kind: "user" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let n = 0; n < 7; n++) await media.createImage({ ...image, id: `queued-${n}` }, { kind: "user" });
  expect(await failure(media.createUnderstanding({ ...request, id: "overflow" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  for (let n = 0; n < 7; n++) await media.cancel(`queued-${n}`);
  expect((await media.cancel(request.id)).phase).toBe("canceled");
  expect((await media.createUnderstanding(request)).phase).toBe("canceled");
  expect((await media.cleanupUnderstanding(request.id)).cleanup).toBe("unknown");
  expect(calls).toBe(1);
});

test("regression: disconnecting cleanup does not leave an unretryable running task", async () => {
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  let blocked = false;
  const http = vendor((request) => {
    if (request.method !== "DELETE") return reply(request);
    if (!blocked) return Response.json({}, { status: 503 });
    enter();
    return never(request.signal);
  });
  await using f = await fixture(http);
  const { media, request } = f;
  await media.createUnderstanding(request);
  await waitFor(
    () => media.get(request.id),
    (row) => row.kind === "understanding" && row.cleanup === "blocked",
    "initial cleanup failed",
  );
  blocked = true;
  const stop = new AbortController();
  const cleanup = failure(media.cleanupUnderstanding(request.id, stop.signal));
  await entered;
  stop.abort();
  await cleanup;
  expect(await media.get(request.id)).toMatchObject({ kind: "understanding", phase: "ready", cleanup: "blocked", canCleanup: true });
});

test.each(["active", "failed", "processing"])("regression: upload status %s gates inference while retaining known IDs for deletion", async (status) => {
  const calls: string[] = [];
  const http = vendor((request) => {
    calls.push(`${request.method} ${request.url}`);
    return request.url.endsWith("/files")
      ? Response.json({ id: "file-one", object: "file", bytes: bytes.length, created_at: 1, filename: "accepted.png", purpose: "image", status })
      : reply(request);
  });
  await using f = await fixture(http);
  const { media, request } = f;
  await media.createUnderstanding(request);
  const phase = status === "active" ? "ready" : status === "failed" ? "failed" : "unknown";
  await waitFor(
    () => media.get(request.id),
    (job) => job.phase === phase,
    "file status handled",
  );
  if (status !== "active") await media.cleanupUnderstanding(request.id);
  await waitFor(
    () => media.get(request.id),
    (job) => job.kind === "understanding" && job.cleanup === "done",
    "known file deleted",
  );
  expect(calls.filter((call) => call.endsWith("/responses"))).toHaveLength(status === "active" ? 1 : 0);
  expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
});

test("regression: restart cancels unsent work, preserves uncertain work and results, and never resubmits", async () => {
  await using f = await fixture(unreachable("Recovery must not call the provider"));
  const { media, input, request } = f;
  const db = f.farm.db;
  const reference = await media.inputs.get(input.id);
  const saved = {
    model: result.model,
    text: "Persisted result",
    status: "completed",
    incompleteReason: null,
    usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
  };
  // The same inputs the Media holds, as a second store over the same tables (a pin under a job's id).
  const pinned = f.inputsOf();
  for (const phase of ["queued", "uploading", "generating", "ready"] as const) {
    const id = `restart-${phase}`;
    const owned = JSON.stringify({ kind: "user" });
    await pinned.pin([input.id], id, async () => {
      await q.insertMediaJob(
        db.sql,
        newJob({
          kind: "understanding",
          id,
          request: JSON.stringify({ ...request, id }),
          inputs: JSON.stringify([reference]),
          source: owned,
          authorization: null,
          phase: "queued",
          connection: "moss",
          revision: request.revision,
          model: "moss-vl-1.0",
          now: 1,
        }),
      );
      const row = await q.mediaJob(db.sql, { id });
      if (row === undefined) throw new Error(`no job ${id}`);
      await q.changeMediaJob(db.sql, {
        ...row,
        id,
        phase,
        source: owned,
        result: phase === "ready" ? JSON.stringify(saved) : null,
        cleanup: phase === "ready" ? "running" : "pending",
        problem: "",
        now: 1,
      });
    });
  }
  await media.start();
  expect(await media.get("restart-queued")).toMatchObject({ phase: "canceled", cleanup: "done" });
  expect(await failure(pinned.blob(input.id, "restart-queued"))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await media.get("restart-uploading")).toMatchObject({ phase: "unknown", cleanup: "pending" });
  expect(await media.get("restart-generating")).toMatchObject({ phase: "unknown", cleanup: "pending" });
  expect(await media.get("restart-ready")).toMatchObject({ phase: "ready", result: saved, cleanup: "blocked" });
  expect((await media.createUnderstanding({ ...request, id: "restart-generating" })).phase).toBe("unknown");
  expect(f.farm.core.state().media).toHaveLength(4);
});

test("user approval freezes inputs and authorizes only one trusted channel execution", async () => {
  const calls: string[] = [];
  const http = vendor((request) => {
    calls.push(`${request.method} ${request.url}`);
    return reply(request);
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  const channel = f.farm.channel.defaultChannel();
  const caller = { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true } as const;
  const granted = await media.authorizeUnderstanding({ ...request, channel });
  expect(granted.phase).toBe("authorized");
  expect(granted.authorization?.channel).toBe(channel);
  expect((await media.inputs.get(input.id)).canDelete).toBe(false);
  expect(calls).toEqual([]);
  for (const other of [{ kind: "user" } as const, { ...caller, forUser: false }, { ...caller, channel: "wrong-channel" }]) {
    expect(await failure(media.startUnderstanding(request.id, other))).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect(await failure(media.createUnderstanding(request))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(media.authorizeUnderstanding({ ...request, channel, prompt: "Different question" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toEqual([]);
  await Promise.all([media.startUnderstanding(request.id, caller), media.startUnderstanding(request.id, caller)]);
  const completed = await waitFor(
    () => media.get(request.id),
    (job) => job.kind === "understanding" && job.cleanup === "done",
    "authorized understanding",
  );
  expect(completed).toMatchObject({ phase: "ready", source: { kind: "orchestrator", agent: caller.agent, channel } });
  expect(await media.startUnderstanding(request.id, caller)).toEqual(completed);
  expect(await failure(media.startUnderstanding(request.id, { ...caller, agent: "other-agent" }))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(calls).toEqual(["POST https://api.mosi.cn/v1/files", "POST https://api.mosi.cn/v1/responses", "DELETE https://api.mosi.cn/v1/files/file-one"]);
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
  notIn(f.farm.core.state().media, "fingerprint");
});

test.each(["cancel", "restart", "expire", "account"] as const)("unused approval cannot upload after %s", async (action) => {
  await using f = await fixture(unreachable("Invalidated approval must not contact the vendor"));
  const { media, input, request } = f;
  const channel = f.farm.channel.defaultChannel();
  const caller = { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true } as const;
  await media.authorizeUnderstanding({ ...request, channel });
  switch (action) {
    case "cancel":
      await media.cancel(request.id);
      break;
    case "restart":
      await media.start();
      break;
    case "expire":
      await f.adjust(minutes(15));
      expect(await failure(media.startUnderstanding(request.id, caller))).toMatchObject({ bizCode: BizCode.MediaRefused });
      await media.cancel(request.id);
      break;
    case "account": {
      const state = f.provider.status();
      await f.provider.update({ ...state, connections: state.connections.map((item) => ({ ...item, key: "changed-account-key" })) });
      expect(await failure(media.startUnderstanding(request.id, caller))).toMatchObject({ bizCode: BizCode.MediaRefused });
      await media.cancel(request.id);
      break;
    }
  }
  expect((await media.startUnderstanding(request.id, caller)).phase).toBe("canceled");
  expect((await media.inputs.get(input.id)).canDelete).toBe(true);
});

test("regression: queued delegated understanding rechecks account before uploading", async () => {
  const http = vendor((request) => {
    if (request.url.endsWith("/images/generations")) return never(request.signal);
    throw new Error("Stale queued approval uploaded");
  });
  await using f = await fixture(http);
  const { media, input, request } = f;
  await media.createImage({ id: "hold-slot", prompt: "Hold", format: "text", width: 256, height: 256, enhance: false, watermark: true }, { kind: "user" });
  await waitFor(
    () => media.get("hold-slot"),
    (job) => job.phase === "generating",
    "shared execution slot occupied",
  );
  const channel = f.farm.channel.defaultChannel();
  await media.authorizeUnderstanding({ ...request, channel });
  await media.startUnderstanding(request.id, { kind: "orchestrator", agent: "authorized-agent", channel, forUser: true });
  const status = f.provider.status();
  await f.provider.update({ ...status, connections: status.connections.map((item) => ({ ...item, key: "changed-before-upload" })) });
  await media.cancel("hold-slot");
  await waitFor(
    () => media.get(request.id),
    (job) => job.phase === "canceled",
    "stale queued approval rejected",
  );
  await waitFor(
    () => media.inputs.get(input.id),
    (item) => item.canDelete,
    "input retention released",
  );
});
