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
        Effect.gen(function* () {
          yield* fs.writeFile(path, data.subarray(0, 1));
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
    });
    const fiber = yield* writeOnce(target, bytes).pipe(Effect.provideService(FileSystem.FileSystem, partial), Effect.forkChild);
    yield* Deferred.await(started);
    const exists2 = yield* fs.exists(target);
    expect(exists2).toBe(false);
    yield* Fiber.interrupt(fiber);
    const directory2 = yield* fs.readDirectory(directory);
    expect(directory2).toEqual([]);
    yield* Effect.all([writeOnce(target, bytes), writeOnce(target, bytes)], { concurrency: 2 });
    const file = yield* fs.readFile(target);
    expect(Buffer.from(file)).toEqual(bytes);
    yield* writeOnce(target, Buffer.from("do not replace"));
    const file2 = yield* fs.readFile(target);
    expect(Buffer.from(file2)).toEqual(bytes);
    const directory3 = yield* fs.readDirectory(directory);
    expect(directory3).toEqual(["hash"]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
