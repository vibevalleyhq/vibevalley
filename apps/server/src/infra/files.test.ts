import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";

import { writeOnce } from "./files.ts";

it.effect("regression: interrupted attachment writes cannot publish a partial hash-named file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const target = join(directory, "hash");
    const bytes = Buffer.from("complete bytes");
    const started = yield* Deferred.make<void>();
    const partial = FileSystem.FileSystem.of({
      ...fs,
      writeFile: (path, data) =>
        fs.writeFile(path, data.subarray(0, 1)).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
    });
    const fiber = yield* writeOnce(target, bytes).pipe(Effect.provideService(FileSystem.FileSystem, partial), Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* fs.exists(target)).toBe(false);
    yield* Fiber.interrupt(fiber);
    expect(yield* fs.readDirectory(directory)).toEqual([]);
    yield* Effect.all([writeOnce(target, bytes), writeOnce(target, bytes)], { concurrency: 2 });
    expect(Buffer.from(yield* fs.readFile(target))).toEqual(bytes);
    yield* writeOnce(target, Buffer.from("do not replace"));
    expect(Buffer.from(yield* fs.readFile(target))).toEqual(bytes);
    expect(yield* fs.readDirectory(directory)).toEqual(["hash"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
