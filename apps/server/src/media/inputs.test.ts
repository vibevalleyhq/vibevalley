import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, PlatformError, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { refused } from "#/base/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Database, Db } from "#/infra/db.ts";
import { testConfig } from "#/testing/layers.ts";
import * as q from "#db/media_input.sql.ts";

import { makeInputs } from "./inputs.ts";
import { wav } from "./testdata/audio.ts";
import { png } from "./testdata/png.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notIn = (value: unknown, secret: string) =>
  Effect.map(json(value), (text) => {
    expect(text).not.toContain(secret);
  });

const layer = () =>
  Db.layer.pipe(Layer.provideMerge(Database), Layer.provideMerge(NodeServices.layer), Layer.provideMerge(Layer.succeed(ServerConfig, testConfig())));
const bytes = png();
const metadata = { kind: "image", name: "input.png", mime: "image/png", size: bytes.length } as const;
const saved = Effect.fnUntraced(function* (inputs: Effect.Success<typeof makeInputs>) {
  const input = yield* inputs.create(metadata);
  return yield* inputs.upload(input.id, Stream.make(bytes));
});

it.effect("input reservations are immutable, deduplicated on disk, and never return private paths", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const inputs = yield* makeInputs;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const first = yield* saved(inputs);
    const second = yield* saved(inputs);
    expect(first.id).not.toBe(second.id);
    expect((yield* inputs.previewDelete(first.id)).does).toHaveLength(1);
    expect((yield* inputs.get(first.id)).phase).toBe("ready");
    expect(first).toMatchObject({ phase: "ready", canDelete: true, hash: second.hash });
    yield* notIn(first, config.home);
    const directory = yield* fs.readDirectory(join(config.home, "media-inputs/content"));
    expect(directory).toEqual([first.hash]);
    const uploaded = yield* inputs.upload(first.id, Stream.fromEffect(Effect.die("do not read a repeated upload")));
    expect(uploaded).toEqual(first);
    yield* inputs.delete(first.id);
    expect((yield* inputs.get(second.id)).phase).toBe("ready");
    const directory2 = yield* fs.readDirectory(join(config.home, "media-inputs/content"));
    expect(directory2).toEqual([second.hash]);
    expect((yield* inputs.previewDelete(second.id)).does).toHaveLength(2);
    yield* inputs.delete(second.id);
    const previewDelete2 = yield* inputs.previewDelete(second.id);
    expect(previewDelete2).toEqual({ does: [] });
    yield* inputs.delete(second.id);
    const directory3 = yield* fs.readDirectory(join(config.home, "media-inputs/content"));
    expect(directory3).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("concurrent reservations cannot overbook the byte quota", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const results = yield* Effect.forEach(
      Array.from({ length: 12 }),
      () => inputs.create({ kind: "video", name: "video.mp4", mime: "video/mp4", size: 200_000_000 }).pipe(Effect.option),
      { concurrency: 12 },
    );
    expect(results.filter(Option.isSome)).toHaveLength(10);
    const inputs2 = yield* inputs.list();
    expect(inputs2).toHaveLength(10);
    const inputs3 = yield* inputs.list();
    yield* Effect.forEach(inputs3, (input) => inputs.delete(input.id), { discard: true });
    expect((yield* inputs.create(metadata)).phase).toBe("reserved");
  }).pipe(Effect.provide(layer())),
);

it.effect("reservation count is bounded even for tiny files", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    yield* Effect.forEach(Array.from({ length: 256 }), () => inputs.create(metadata), { discard: true, concurrency: 16 });
    const createdFailure = yield* Effect.flip(inputs.create(metadata));
    expect(createdFailure).toMatchObject({ _tag: "Refused" });
    const inputs2 = yield* inputs.list();
    expect(inputs2).toHaveLength(256);
  }).pipe(Effect.provide(layer())),
);

it.effect("references survive expiry and restart, and release permits cleanup", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const first = yield* saved(inputs);
    const unused = yield* saved(inputs);
    yield* inputs.pin([first.id], "task-a", Effect.void);
    expect((yield* inputs.get(first.id)).canDelete).toBe(false);
    const deletedFailure = yield* Effect.flip(inputs.delete(first.id));
    expect(deletedFailure).toMatchObject({ _tag: "Refused" });
    const previewDeleteFailure = yield* Effect.flip(inputs.previewDelete(first.id));
    expect(previewDeleteFailure).toMatchObject({ _tag: "Refused" });
    yield* TestClock.adjust("24 hours");
    const restarted = yield* makeInputs;
    yield* restarted.restore();
    yield* restarted.sweep();
    expect((yield* restarted.get(first.id)).phase).toBe("ready");
    const restartedFailure = yield* Effect.flip(restarted.get(unused.id));
    expect(restartedFailure).toMatchObject({ _tag: "Refused" });
    yield* restarted.release("task-a");
    yield* restarted.sweep();
    const restarteds = yield* restarted.list();
    expect(restarteds).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("reference acquisition and admission roll back together", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const first = yield* saved(inputs);
    yield* Effect.flip(inputs.pin([first.id, "missing"], "task-a", Effect.void));
    expect((yield* inputs.get(first.id)).canDelete).toBe(true);
    yield* Effect.flip(inputs.pin([first.id], "task-b", Effect.fail(refused("admission failed"))));
    expect((yield* inputs.get(first.id)).canDelete).toBe(true);
    yield* inputs.pin([first.id, first.id], "task-c", Effect.void);
    yield* inputs.release("task-c");
    yield* inputs.delete(first.id);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: an interrupted upload releases admission and permits an explicit local retry", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const input = yield* inputs.create(metadata);
    const reading = yield* Deferred.make<void>();
    const source = Stream.concat(
      Stream.make(bytes.subarray(0, 32)),
      Stream.fromEffect(Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))),
    );
    const fiber = yield* inputs.upload(input.id, source).pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    expect((yield* inputs.get(input.id)).canDelete).toBe(false);
    const deletedFailure = yield* Effect.flip(inputs.delete(input.id));
    expect(deletedFailure).toMatchObject({ _tag: "Refused" });
    const uploadedFailure = yield* Effect.flip(inputs.upload(input.id, Stream.make(bytes)));
    expect(uploadedFailure).toMatchObject({ _tag: "Refused" });
    yield* Fiber.interrupt(fiber);
    expect((yield* inputs.get(input.id)).phase).toBe("failed");
    expect((yield* inputs.upload(input.id, Stream.make(bytes))).canDelete).toBe(true);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: failed partial-file cleanup retains its reservation and cannot accumulate retry files", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = join((yield* ServerConfig).home, "media-inputs/staging");
    let blocked = false;
    const remove: typeof fs.remove = (path, options) =>
      blocked && path.startsWith(root + "/")
        ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" }))
        : fs.remove(path, options);
    const failing = FileSystem.FileSystem.of({
      ...fs,
      remove,
      makeTempDirectoryScoped: (options) =>
        Effect.acquireRelease(fs.makeTempDirectory(options), (directory) => remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)),
    });
    const inputs = yield* makeInputs.pipe(Effect.provideService(FileSystem.FileSystem, failing));
    const input = yield* inputs.create(metadata);
    const source = Stream.make(bytes.subarray(0, 32)).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          blocked = true;
        }),
      ),
    );
    const uploaded = yield* Effect.exit(inputs.upload(input.id, source));
    expect(Exit.isFailure(uploaded)).toBe(true);
    expect((yield* inputs.get(input.id)).phase).toBe("failed");
    const directory2 = yield* fs.readDirectory(join(root, input.id));
    expect(directory2).toHaveLength(1);
    const uploadedFailure = yield* Effect.flip(inputs.upload(input.id, Stream.fromEffect(Effect.die("must not accept another file"))));
    expect(uploadedFailure).toMatchObject({ _tag: "Refused" });
    const deletedFailure = yield* Effect.flip(inputs.delete(input.id));
    expect(deletedFailure).toMatchObject({ _tag: "Refused" });
    yield* inputs.sweep();
    const inputs2 = yield* inputs.list();
    expect(inputs2).toHaveLength(1);
    blocked = false;
    yield* inputs.sweep();
    const inputs3 = yield* inputs.list();
    expect(inputs3).toEqual([]);
    const exists2 = yield* fs.exists(join(root, input.id));
    expect(exists2).toBe(false);
  }).pipe(Effect.provide(layer())),
);

it.effect("at most eight streams are accepted concurrently and timeout releases every slot", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const active = yield* Effect.forEach(Array.from({ length: 8 }), () =>
      Effect.gen(function* () {
        const input = yield* inputs.create(metadata);
        const started = yield* Deferred.make<void>();
        const source = Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)));
        const fiber = yield* inputs.upload(input.id, source).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        return fiber;
      }),
    );
    const next = yield* inputs.create(metadata);
    const uploadedFailure = yield* Effect.flip(inputs.upload(next.id, Stream.make(bytes)));
    expect(uploadedFailure).toMatchObject({ _tag: "Refused" });
    yield* TestClock.adjust("300 seconds");
    yield* Effect.forEach(active, Fiber.join, { discard: true });
    expect((yield* inputs.upload(next.id, Stream.make(bytes))).phase).toBe("ready");
  }).pipe(Effect.provide(layer())),
);

it.effect("startup removes partial and orphan files without repeating any upload", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const inputs = yield* makeInputs;
    const input = yield* inputs.create(metadata);
    const db = yield* Db;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const root = join(config.home, "media-inputs");
    yield* fs.makeDirectory(join(root, "staging/.input-interrupted"), { recursive: true });
    yield* fs.writeFileString(join(root, "staging/.input-interrupted/content"), "partial");
    yield* fs.makeDirectory(join(root, "content"), { recursive: true });
    yield* fs.writeFileString(join(root, "content", "0".repeat(64)), "orphan");
    yield* db.run(q.changeInput({ id: input.id, phase: "uploading", hash: null, expires: input.expiresAt }));
    const restarted = yield* makeInputs;
    yield* restarted.restore();
    expect((yield* restarted.get(input.id)).phase).toBe("failed");
    const exists2 = yield* fs.exists(join(root, "staging"));
    expect(exists2).toBe(false);
    const directory = yield* fs.readDirectory(join(root, "content"));
    expect(directory).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: repairing a missing saved input cannot replace its original content", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const inputs = yield* makeInputs;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const input = yield* saved(inputs);
    yield* fs.remove(join(config.home, "media-inputs/content", input.hash ?? ""));
    const restarted = yield* makeInputs;
    yield* restarted.restore();
    expect((yield* restarted.get(input.id)).phase).toBe("failed");
    const different = Buffer.from(bytes);
    different[20] = 23;
    const uploadedFailure = yield* Effect.flip(restarted.upload(input.id, Stream.make(different)));
    expect(uploadedFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* restarted.upload(input.id, Stream.make(bytes))).hash).toBe(input.hash);
  }).pipe(Effect.provide(layer())),
);

it.effect.each([false, true])("regression: a rejected database commit remains accounted and retryable when rollback is blocked: %s", (blockRollback) =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const root = join((yield* ServerConfig).home, "media-inputs");
    const content = join(root, "content");
    let blocked = blockRollback;
    const failing = FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        blocked && path.startsWith(content + "/")
          ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" }))
          : fs.remove(path, options),
    });
    const inputs = yield* makeInputs.pipe(Effect.provideService(FileSystem.FileSystem, failing));
    const input = yield* inputs.create(metadata);
    yield* sql.unsafe(
      "CREATE TRIGGER media_input_test_fail BEFORE UPDATE OF phase ON media_input WHEN NEW.phase = 'ready' BEGIN SELECT RAISE(ABORT, 'injected database failure'); END",
    );
    const error = yield* Effect.flip(inputs.upload(input.id, Stream.make(bytes)));
    expect(error).toMatchObject({ _tag: "Refused" });
    yield* notIn(error, "injected database failure");
    const failed = yield* inputs.get(input.id);
    expect(failed).toMatchObject({ phase: "failed" });
    expect(failed.hash).not.toBeNull();
    const directory = yield* fs.readDirectory(join(root, "content"));
    expect(directory).toEqual(blockRollback ? [failed.hash] : []);
    const directory2 = yield* fs.readDirectory(join(root, "staging"));
    expect(directory2).toEqual([]);
    blocked = false;
    yield* sql.unsafe("DROP TRIGGER media_input_test_fail");
    expect((yield* inputs.upload(input.id, Stream.make(bytes))).phase).toBe("ready");
  }).pipe(Effect.provide(layer())),
);

it.effect("failed deletion remains a tombstone and is resumed after restart", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    let blocked = "";
    const failing = FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        path === blocked
          ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" }))
          : fs.remove(path, options),
    });
    const inputs = yield* makeInputs.pipe(Effect.provideService(FileSystem.FileSystem, failing));
    const input = yield* saved(inputs);
    blocked = join((yield* ServerConfig).home, "media-inputs/content", input.hash ?? "");
    const deletedFailure = yield* Effect.flip(inputs.delete(input.id));
    expect(deletedFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* inputs.get(input.id)).phase).toBe("deleting");
    const uploadedFailure = yield* Effect.flip(inputs.upload(input.id, Stream.make(bytes)));
    expect(uploadedFailure).toMatchObject({ _tag: "Refused" });
    yield* inputs.create(metadata);
    yield* TestClock.adjust("24 hours");
    yield* inputs.sweep();
    expect((yield* inputs.list()).map((row) => row.id)).toEqual([input.id]);
    const restarted = yield* makeInputs;
    yield* restarted.restore();
    yield* restarted.sweep();
    const restarteds = yield* restarted.list();
    expect(restarteds).toEqual([]);
    const exists2 = yield* fs.exists(blocked);
    expect(exists2).toBe(false);
  }).pipe(Effect.provide(layer())),
);

it.effect("only the retaining task can obtain a checked disk-backed Blob", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const input = yield* saved(inputs);
    const blobFailure = yield* Effect.flip(inputs.blob(input.id, "task-a"));
    expect(blobFailure).toMatchObject({ _tag: "Refused" });
    yield* inputs.pin([input.id], "task-a", Effect.void);
    const blobFailure2 = yield* Effect.flip(inputs.blob(input.id, "task-b"));
    expect(blobFailure2).toMatchObject({ _tag: "Refused" });
    const blob = yield* inputs.blob(input.id, "task-a");
    expect([blob.size, blob.type]).toEqual([bytes.length, "image/png"]);
    const arrayBuffer2 = yield* Effect.promise(() => blob.arrayBuffer());
    expect(Buffer.from(arrayBuffer2)).toEqual(bytes);
    yield* inputs.release("task-a");
    const blobFailure3 = yield* Effect.flip(inputs.blob(input.id, "task-a"));
    expect(blobFailure3).toMatchObject({ _tag: "Refused" });
  }).pipe(Effect.provide(layer())),
);

it.effect.each(["changed", "truncated", "grown", "missing"])("regression: %s input bytes cannot be sent to a provider", (failure) =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const inputs = yield* makeInputs;
    const input = yield* saved(inputs);
    const fs = yield* FileSystem.FileSystem;
    const path = join((yield* ServerConfig).home, "media-inputs/content", input.hash ?? "");
    yield* inputs.pin([input.id], "task-a", Effect.void);
    const changed = Buffer.from(bytes);
    changed[20] = 23;
    if (failure === "missing") yield* fs.remove(path);
    else yield* fs.writeFile(path, failure === "changed" ? changed : failure === "truncated" ? bytes.subarray(0, 20) : Buffer.concat([bytes, bytes]));
    const error = yield* Effect.flip(inputs.blob(input.id, "task-a"));
    expect(error).toMatchObject({ _tag: "Refused" });
    yield* notIn(error, path);
    expect((yield* inputs.get(input.id)).phase).toBe("failed");
    expect((yield* inputs.upload(input.id, Stream.make(bytes))).phase).toBe("ready");
    const repaired = yield* inputs.blob(input.id, "task-a");
    const arrayBuffer2 = yield* Effect.promise(() => repaired.arrayBuffer());
    expect(Buffer.from(arrayBuffer2)).toEqual(bytes);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: retained audio content remains playable after expiry while unretained and corrupt inputs cannot be read", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const bytes = wav();
    const metadata = { kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length } as const;
    const first = yield* inputs.create(metadata);
    const second = yield* inputs.create(metadata);
    yield* inputs.upload(first.id, Stream.make(bytes.subarray(0, 5), bytes.subarray(5)));
    yield* inputs.upload(second.id, Stream.make(bytes));
    yield* inputs.pin([first.id], "transcript", Effect.void);
    yield* TestClock.adjust("25 hours");
    const contentFailure = yield* inputs.content(second.id).pipe(Effect.flip);
    expect(contentFailure).toMatchObject({ _tag: "Refused" });
    const content = yield* inputs.content(first.id);
    expect(content).toMatchObject({ mime: "audio/wav", size: bytes.length, name: "sample.wav" });
    yield* (yield* FileSystem.FileSystem).writeFile(content.path, Buffer.alloc(bytes.length));
    const error = yield* inputs.content(first.id).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "Refused" });
    yield* notIn(error, content.path);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: generated raw PCM uses the hash store without inventing metadata or weakening public uploads", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const source = Uint8Array.of(1, 2, 3, 4);
    const createdFailure = yield* inputs.create({ kind: "audio", name: "raw.pcm", mime: "audio/pcm", size: source.length }).pipe(Effect.flip);
    expect(createdFailure).toMatchObject({
      _tag: "Refused",
    });
    const first = yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* inputs.stageResult("raw.pcm", "pcm", Stream.make(source));
        expect(staged.metadata).toBeUndefined();
        return yield* inputs.storeResult(staged, "first");
      }),
    );
    const second = yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* inputs.stageResult("raw.pcm", "pcm", Stream.make(source));
        return yield* inputs.storeResult(staged, "second");
      }),
    );
    expect(first.hash).toBe(second.hash);
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const root = join((yield* ServerConfig).home, "media-inputs");
    const directory = yield* fs.readDirectory(join(root, "content"));
    expect(directory).toEqual([first.hash]);
    const directory2 = yield* fs.readDirectory(join(root, "staging"));
    expect(directory2).toEqual([]);
    expect((yield* inputs.content(first.id)).mime).toBe("audio/pcm");
    yield* inputs.release("unrelated");
    expect((yield* inputs.get(first.id)).canDelete).toBe(false);
    yield* inputs.release("first");
    yield* inputs.delete(first.id);
    expect((yield* inputs.content(second.id)).size).toBe(source.length);
    expect((yield* (yield* Db).run(q.inputCapacity())).bytes).toBe(source.length);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: generated staging observes reserved quota and releases failed temporary bytes", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const inputs = yield* makeInputs;
    for (let index = 0; index < 4; index++) yield* inputs.create({ kind: "audio", name: `reserved-${index}.wav`, mime: "audio/wav", size: 512_000_000 });
    yield* inputs.create({ kind: "audio", name: "remainder.wav", mime: "audio/wav", size: 2 * 1024 * 1024 * 1024 - 4 * 512_000_000 - 4 });
    const resultStagedFailure = yield* inputs.stageResult("too-large.pcm", "pcm", Stream.make(new Uint8Array(5))).pipe(Effect.scoped, Effect.flip);
    expect(resultStagedFailure).toMatchObject({
      _tag: "Refused",
    });
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.readDirectory(join((yield* ServerConfig).home, "media-inputs/staging"));
    expect(directory).toEqual([]);
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* inputs.stageResult("fits.pcm", "pcm", Stream.make(new Uint8Array(4)));
        return yield* inputs.storeResult(staged, "fits");
      }),
    );
    expect((yield* inputs.content(result.id)).size).toBe(4);
    expect((yield* (yield* Db).run(q.inputCapacity())).bytes).toBe(2 * 1024 * 1024 * 1024);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: failed generated-result promotion rolls back rows, pins, and temporary files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failing = FileSystem.FileSystem.of({
      ...fs,
      rename: () => Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" })),
    });
    const inputs = yield* makeInputs.pipe(Effect.provideService(FileSystem.FileSystem, failing));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* inputs.stageResult("sample.wav", "wav", Stream.make(wav()));
        const storeResultFailure = yield* inputs.storeResult(staged, "failed").pipe(Effect.flip);
        expect(storeResultFailure).toMatchObject({ _tag: "Refused" });
      }),
    );
    const inputs2 = yield* inputs.list();
    expect(inputs2).toEqual([]);
    const { join } = yield* Path.Path;
    const root = join((yield* ServerConfig).home, "media-inputs");
    const directory = yield* fs.readDirectory(join(root, "staging"));
    expect(directory).toEqual([]);
    const directory2 = yield* fs.readDirectory(join(root, "content"));
    expect(directory2).toEqual([]);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: explicit asset release preserves shared pins and content until the final holder releases quota", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const first = yield* saved(inputs);
    const sharedContent = yield* saved(inputs);
    yield* inputs.pin([first.id], "job-a", Effect.void);
    yield* inputs.pin([first.id], "job-b", Effect.void);
    yield* inputs.pin([sharedContent.id], "job-c", Effect.void);
    yield* TestClock.adjust("25 hours");
    yield* inputs.sweep();
    expect((yield* (yield* Db).run(q.inputCapacity())).bytes).toBe(bytes.length * 2);
    yield* inputs.releaseAssets([first.id], ["job-a"], Effect.void);
    expect((yield* inputs.get(first.id)).canDelete).toBe(false);
    expect((yield* inputs.blob(first.id, "job-b")).size).toBe(bytes.length);
    const blobFailure = yield* inputs.blob(first.id, "job-a").pipe(Effect.flip);
    expect(blobFailure).toMatchObject({ _tag: "Refused" });
    yield* inputs.releaseAssets([first.id], ["job-b"], Effect.void);
    const inputFailure = yield* inputs.get(first.id).pipe(Effect.flip);
    expect(inputFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* inputs.content(sharedContent.id)).size).toBe(bytes.length);
    expect((yield* (yield* Db).run(q.inputCapacity())).bytes).toBe(bytes.length);
    yield* inputs.releaseAssets([sharedContent.id], ["job-c"], Effect.void);
    const outcome = yield* (yield* Db).run(q.inputCapacity());
    expect(outcome).toEqual({ bytes: 0, count: 0 });
    expect((yield* inputs.create(metadata)).phase).toBe("reserved");
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: failed reference clearing rolls back asset pins and leaves bytes readable", () =>
  Effect.gen(function* () {
    const inputs = yield* makeInputs;
    const input = yield* saved(inputs);
    yield* inputs.pin([input.id], "job", Effect.void);
    const assetsReleasedFailure = yield* inputs.releaseAssets([input.id], ["job"], Effect.fail(refused("clear failed"))).pipe(Effect.flip);
    expect(assetsReleasedFailure).toMatchObject({ _tag: "Refused" });
    expect((yield* inputs.get(input.id)).canDelete).toBe(false);
    expect((yield* inputs.blob(input.id, "job")).size).toBe(bytes.length);
  }).pipe(Effect.provide(layer())),
);

it.effect("regression: failed explicit unlink keeps a quota-accounted tombstone for restart cleanup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let blocked = "";
    const failing = FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        path === blocked
          ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" }))
          : fs.remove(path, options),
    });
    const inputs = yield* makeInputs.pipe(Effect.provideService(FileSystem.FileSystem, failing));
    const input = yield* saved(inputs);
    yield* inputs.pin([input.id], "job", Effect.void);
    blocked = (yield* inputs.content(input.id)).path;
    const assetsReleasedFailure = yield* inputs.releaseAssets([input.id], ["job"], Effect.void).pipe(Effect.flip);
    expect(assetsReleasedFailure).toMatchObject({ _tag: "Refused" });
    const input2 = yield* inputs.get(input.id);
    expect(input2).toMatchObject({ phase: "deleting", canDelete: true });
    const outcome = yield* (yield* Db).run(q.inputCapacity());
    expect(outcome).toEqual({ bytes: bytes.length, count: 1 });
    blocked = "";
    const restarted = yield* makeInputs;
    yield* restarted.restore();
    yield* restarted.sweep();
    const outcome2 = yield* (yield* Db).run(q.inputCapacity());
    expect(outcome2).toEqual({ bytes: 0, count: 0 });
  }).pipe(Effect.provide(layer())),
);
