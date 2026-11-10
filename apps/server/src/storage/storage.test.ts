import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Array as Arr, Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "#/infra/config.ts";
import { testConfig } from "#/testing/layers.ts";

import { Storage } from "./storage.ts";

const bytes = new TextEncoder().encode("a kept file");
// Storage takes the key it is given; the caller (Attachment) hashes the bytes.
const key = "d686580a17015eb1824fae75642d75248f1b50ee5147941530f117716243330d";

layer(Storage.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(Layer.succeed(ServerConfig, testConfig()))), { excludeTestServices: true })(
  "storage on the local disk",
  (it) => {
    it.effect("keeps a key once, reads it back, and deletes it", () =>
      Effect.gen(function* () {
        const storage = yield* Storage;
        yield* storage.put(key, bytes);
        yield* storage.put(key, bytes);
        const fs = yield* FileSystem.FileSystem;
        const { dirname } = yield* Path.Path;
        const kept = yield* fs.readDirectory(dirname(storage.pathOf(key)));
        expect(Arr.filter(kept, (name) => name === key)).toEqual([key]);
        const size = yield* storage.size(key);
        expect(size).toBe(bytes.length);
        const blob = yield* storage.open(key, "text/plain");
        const read = yield* Effect.promise(() => blob.text());
        expect([read, blob.type]).toEqual(["a kept file", "text/plain"]);
        yield* storage.delete(key);
        const gone = yield* storage.exists(key);
        expect(gone).toBe(false);
      }),
    );

    it.effect("a streamed put is published whole, and a cancelled one leaves nothing at its key", () =>
      Effect.gen(function* () {
        const storage = yield* Storage;
        const other = "0000000000000000000000000000000000000000000000000000000000000000";
        const started = yield* Deferred.make<void>();
        const endless = Stream.concat(Stream.make(bytes), Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))));
        const fiber = yield* storage.putStream(other, endless).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const left = yield* storage.exists(other);
        expect(left).toBe(false);
        const fs = yield* FileSystem.FileSystem;
        const staged = yield* fs.readDirectory(storage.scratch);
        expect(staged).toEqual([]);
        yield* storage.putStream(key, Stream.make(bytes.subarray(0, 4), bytes.subarray(4)));
        const read = yield* Stream.mkString(Stream.decodeText(storage.stream(key)));
        expect(read).toBe("a kept file");
      }),
    );
  },
);
