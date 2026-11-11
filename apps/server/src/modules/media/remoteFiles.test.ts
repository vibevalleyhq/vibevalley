import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { BizCode } from "@vibevalley/protocol/api";

import { ServerConfig } from "#/infra/config.ts";
import { Database, Db } from "#/infra/db.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { png } from "#/modules/media/testdata/png.ts";
import { Provider } from "#/modules/provider/provider.ts";
import { Setting } from "#/modules/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";
import * as q from "#db/media_remote_file.sql.ts";

import { makeInputs } from "./inputs.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });

/** The library, and a Provider whose accounts' calls go to the given vendor. */
const layer = (http: HttpClient.HttpClient) =>
  Layer.mergeAll(
    Attachment.layer.pipe(Layer.provideMerge(Db.layer), Layer.provideMerge(Database)),
    Provider.layer.pipe(Layer.provide(Setting.layer), Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(Layer.succeed(ServerConfig, testConfig())));
const key = "isolated-test-key";
/** The account a task binds. */
const bound = Effect.gen(function* () {
  const provider = yield* Provider;
  yield* provider.update({
    revision: 0,
    connections: [{ id: "moss-a", name: "MOSS", adapter: "moss", enabled: true, key }],
    dictation: null,
    image: null,
    understanding: null,
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    live: null,
  });
  return yield* provider.account({ connection: "moss-a", model: "moss-vl-1.0" });
});
const bytes = png();
const fixture = Effect.gen(function* () {
  const inputs = yield* makeInputs;
  const input = yield* inputs.create({ kind: "image", mime: "image/png", name: "private-user-filename.png", size: bytes.length });
  yield* inputs.upload(input.id, Stream.make(bytes));
  yield* inputs.pin([input.id], "task-a", Effect.void);
  return { inputs, input, remote: yield* makeRemoteFiles(inputs) };
});
const uploaded = { id: "file-one", object: "file", bytes: bytes.length, created_at: 1, filename: "accepted.png", purpose: "image", status: "processed" };

it.effect("a real disk-backed input is uploaded once, recorded without its key, and explicitly cleaned", () => {
  const calls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(request.method);
      expect(request.headers.authorization).toBe(`Bearer ${key}`);
      if (request.method === "POST") {
        if (request.body._tag !== "FormData") return yield* Effect.die("Expected multipart");
        const file = request.body.formData.get("file");
        if (!(file instanceof File)) return yield* Effect.die("Expected disk-backed file");
        expect(file.name).toMatch(/^vv-[0-9a-f-]+\.png$/u);
        expect(file.name).not.toContain("private-user");
        const arrayBuffer2 = yield* Effect.promise(() => file.arrayBuffer());
        expect(Buffer.from(arrayBuffer2)).toEqual(bytes);
        return HttpClientResponse.fromWeb(request, Response.json({ ...uploaded, filename: file.name }));
      }
      return HttpClientResponse.fromWeb(request, Response.json({ id: "file-one", object: "file", deleted: true }));
    }),
  );
  return Effect.gen(function* () {
    const { remote, input } = yield* fixture;
    const account = yield* bound;
    const effects = yield* Effect.all([remote.upload("task-a", input.id, account), remote.upload("task-a", input.id, account)], { concurrency: 2 });
    expect(effects).toEqual(["file-one", "file-one"]);
    const uploaded2 = yield* remote.upload("task-a", input.id, account);
    expect(uploaded2).toBe("file-one");
    const rows = yield* remote.list("task-a");
    expect(rows).toHaveLength(1);
    yield* notIn(rows, key);
    expect(rows[0]).toMatchObject({ phase: "ready", remote_id: "file-one", revision: 1 });
    yield* remote.remove("task-a", input.id, { ...account, revision: 2 });
    yield* remote.remove("task-a", input.id, account);
    expect(calls).toEqual(["POST", "DELETE"]);
    const uploadedFailure = yield* Effect.flip(remote.upload("task-a", input.id, account));
    expect(uploadedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect((yield* remote.list("task-a"))[0]?.phase).toBe("deleted");
  }).pipe(Effect.provide(layer(http)));
});

it.effect.each([400, 503])("an upload returning %s is never resubmitted, including after restart", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "private response" }, { status })));
  });
  return Effect.gen(function* () {
    const { remote, inputs, input } = yield* fixture;
    const account = yield* bound;
    const error = yield* Effect.flip(remote.upload("task-a", input.id, account));
    yield* notIn(error, "private response");
    const restarted = yield* makeRemoteFiles(inputs);
    yield* restarted.restore();
    const uploadedFailure = yield* Effect.flip(restarted.upload("task-a", input.id, account));
    expect(uploadedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect((yield* restarted.list("task-a"))[0]?.phase).toBe(status === 400 ? "rejected" : "unknown");
    if (status === 400) yield* restarted.remove("task-a", input.id, account);
    else {
      const removeFailure = yield* Effect.flip(restarted.remove("task-a", input.id, account));
      expect(removeFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    }
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect.each(["cancel", "timeout"])("regression: %s during remote upload records an unknown result", (action) => {
  const started = Deferred.makeUnsafe<void>();
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
  });
  return Effect.gen(function* () {
    const { remote, input } = yield* fixture;
    const account = yield* bound;
    const fiber = yield* remote.upload("task-a", input.id, account).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else {
      yield* TestClock.adjust("300 seconds");
      const fiber2 = yield* Fiber.join(fiber);
      expect(fiber2).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    }
    expect((yield* remote.list("task-a"))[0]?.phase).toBe("unknown");
    const uploadedFailure = yield* Effect.flip(remote.upload("task-a", input.id, account));
    expect(uploadedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("a task without a retained input cannot upload another task's local file", () => {
  const http = HttpClient.make(() => Effect.die("Unretained input must not reach the network"));
  return Effect.gen(function* () {
    const { remote, input } = yield* fixture;
    const account = yield* bound;
    const uploadedFailure = yield* Effect.flip(remote.upload("other-task", input.id, account));
    expect(uploadedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.MediaRefused });
    const remotes = yield* remote.list("other-task");
    expect(remotes).toEqual([]);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("changed credentials or connection cannot access or delete a recorded upload", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(uploaded)));
  });
  return Effect.gen(function* () {
    const { remote, input } = yield* fixture;
    const account = yield* bound;
    yield* remote.upload("task-a", input.id, account);
    for (const replacement of [
      { ...account, fingerprint: "another key's fingerprint" },
      { ...account, connection: "other-account" },
    ]) {
      yield* Effect.flip(remote.upload("task-a", input.id, replacement));
      yield* Effect.flip(remote.remove("task-a", input.id, replacement));
    }
    const uploaded2 = yield* remote.upload("task-a", input.id, { ...account, revision: 42 });
    expect(uploaded2).toBe("file-one");
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("failed deletion persists its intent and an explicit retry accepts an already absent file", () => {
  const calls: string[] = [];
  let deletion = 500;
  const http = HttpClient.make((request) => {
    calls.push(request.method);
    return Effect.succeed(HttpClientResponse.fromWeb(request, request.method === "POST" ? Response.json(uploaded) : Response.json({}, { status: deletion })));
  });
  return Effect.gen(function* () {
    const { remote, inputs, input } = yield* fixture;
    const account = yield* bound;
    yield* remote.upload("task-a", input.id, account);
    yield* Effect.flip(remote.remove("task-a", input.id, account));
    expect((yield* remote.list("task-a"))[0]?.phase).toBe("deleting");
    const restarted = yield* makeRemoteFiles(inputs);
    yield* restarted.restore();
    expect(calls).toEqual(["POST", "DELETE"]);
    deletion = 404;
    yield* restarted.remove("task-a", input.id, account);
    expect((yield* restarted.list("task-a"))[0]?.phase).toBe("deleted");
    expect(calls).toEqual(["POST", "DELETE", "DELETE"]);
  }).pipe(Effect.provide(layer(http)));
});

it.effect("startup marks an interrupted submission unknown without performing network requests", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(uploaded)));
  });
  return Effect.gen(function* () {
    const { remote, inputs, input } = yield* fixture;
    const account = yield* bound;
    yield* remote.upload("task-a", input.id, account);
    const row = (yield* remote.list("task-a"))[0];
    if (!row) return yield* Effect.die("Missing fixture row");
    yield* (yield* Db).run(q.changeRemoteFile({ id: row.id, phase: "uploading", remote_id: null, now: yield* Clock.currentTimeMillis }));
    const restarted = yield* makeRemoteFiles(inputs);
    yield* restarted.restore();
    expect((yield* restarted.list("task-a"))[0]?.phase).toBe("unknown");
    yield* Effect.flip(restarted.upload("task-a", input.id, account));
    yield* Effect.flip(restarted.remove("task-a", input.id, account));
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer(http)));
});
