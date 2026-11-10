import { Context, Effect, FileSystem, Layer, Path, Schema, Sink, Stream } from "effect";

import { messageOf } from "#/base/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { fileBlob, writeOnce } from "#/infra/files.ts";

export class StorageError extends Schema.TaggedError<StorageError, { readonly brand: unique symbol }>()("StorageError", {
  message: Schema.String,
}) {}

const failed = (cause: unknown) => StorageError.make({ message: messageOf(cause) });

export class Storage extends Context.Service<
  Storage,
  {
    readonly put: (key: string, bytes: Uint8Array) => Effect.Effect<void, StorageError>;
    /** Publishes atomically once complete; cancelled streams leave nothing at `key`. */
    readonly putStream: <E>(key: string, source: Stream.Stream<Uint8Array, E>) => Effect.Effect<void, StorageError | E>;
    readonly adopt: (key: string, file: string, retain?: boolean) => Effect.Effect<void, StorageError>;
    readonly open: (key: string, type: string) => Effect.Effect<Blob, StorageError>;
    readonly stream: (key: string) => Stream.Stream<Uint8Array, StorageError>;
    readonly exists: (key: string) => Effect.Effect<boolean, StorageError>;
    readonly size: (key: string) => Effect.Effect<number, StorageError>;
    readonly delete: (key: string) => Effect.Effect<void, StorageError>;
    readonly scratch: string;
    /** The local implementation's: where the bytes are on this machine, for what must hand a path on (an HTTP file
     * response, a helper's envelope, a vendor upload). Another implementation would have to download first. */
    readonly pathOf: (key: string) => string;
  }
>()("@vibevalley/server/storage/storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const root = join(config.home, "attachments");
      // Shares root's filesystem so adopt() is an atomic rename; content keys are 64-hex sha256, never "staging".
      const scratch = join(root, "staging");
      const pathOf = (key: string) => join(root, key);

      return Storage.of({
        scratch,
        pathOf,
        exists: Effect.fn("Storage.exists")((key: string) => fs.exists(pathOf(key)), Effect.mapError(failed)),
        put: Effect.fn("Storage.put")(
          (key: string, bytes: Uint8Array) => writeOnce(pathOf(key), bytes).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
          Effect.mapError(failed),
        ),
        putStream: Effect.fn("Storage.putStream")(function* <E>(key: string, source: Stream.Stream<Uint8Array, E>) {
          const temporary = yield* Effect.gen(function* () {
            yield* fs.makeDirectory(scratch, { recursive: true, mode: 0o700 });
            const directory = yield* fs.makeTempDirectoryScoped({ directory: scratch, prefix: ".put-" });
            return join(directory, "content");
          }).pipe(Effect.mapError(failed));
          yield* Stream.run(source, fs.sink(temporary, { flag: "wx", mode: 0o600 }).pipe(Sink.mapError(failed)));
          yield* Effect.gen(function* () {
            if (!(yield* fs.exists(pathOf(key)))) yield* fs.rename(temporary, pathOf(key));
          }).pipe(Effect.mapError(failed));
        }, Effect.scoped),
        adopt: Effect.fn("Storage.adopt")(function* (key: string, file: string, retain = false) {
          yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
          const target = pathOf(key);
          if (retain) {
            yield* fs.remove(target, { force: true });
            yield* fs.link(file, target);
          } else yield* fs.rename(file, target);
        }, Effect.mapError(failed)),
        open: Effect.fn("Storage.open")((key: string, type: string) => fileBlob(pathOf(key), type), Effect.mapError(failed)),
        stream: (key) => fs.stream(pathOf(key)).pipe(Stream.mapError(failed)),
        size: Effect.fn("Storage.size")((key: string) => Effect.map(fs.stat(pathOf(key)), (info) => Number(info.size)), Effect.mapError(failed)),
        delete: Effect.fn("Storage.delete")((key: string) => fs.remove(pathOf(key), { force: true }), Effect.mapError(failed)),
      });
    }),
  );
}
