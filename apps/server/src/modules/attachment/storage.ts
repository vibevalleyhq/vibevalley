import { Effect, FileSystem, Path, Schema, Sink, Stream } from "effect";

import { messageOf } from "#/base/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { fileBlob, writeOnce } from "#/infra/files.ts";

export class StorageError extends Schema.TaggedError<StorageError, { readonly brand: unique symbol }>()("StorageError", {
  message: Schema.String,
}) {}

const failed = (cause: unknown) => StorageError.make({ message: messageOf(cause) });

export const makeStorage = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const root = join(config.home, "attachments");
  // Shares root's filesystem so adopt() is an atomic rename; content keys are 64-hex sha256, never "staging".
  const scratch = join(root, "staging");
  const pathOf = (key: string) => join(root, key);

  return {
    scratch,
    pathOf,
    exists: Effect.fn("AttachmentStorage.exists")((key: string) => fs.exists(pathOf(key)), Effect.mapError(failed)),
    put: Effect.fn("AttachmentStorage.put")(
      (key: string, bytes: Uint8Array) => writeOnce(pathOf(key), bytes).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      Effect.mapError(failed),
    ),
    putStream: Effect.fn("AttachmentStorage.putStream")(function* <E>(key: string, source: Stream.Stream<Uint8Array, E>) {
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
    adopt: Effect.fn("AttachmentStorage.adopt")(function* (key: string, file: string, retain?: boolean) {
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      const target = pathOf(key);
      if (retain === true) {
        yield* fs.remove(target, { force: true });
        yield* fs.link(file, target);
      } else yield* fs.rename(file, target);
    }, Effect.mapError(failed)),
    open: Effect.fn("AttachmentStorage.open")((key: string, type: string) => fileBlob(pathOf(key), type), Effect.mapError(failed)),
    stream: (key: string): Stream.Stream<Uint8Array, StorageError> => fs.stream(pathOf(key)).pipe(Stream.mapError(failed)),
    size: Effect.fn("AttachmentStorage.size")((key: string) => Effect.map(fs.stat(pathOf(key)), (info) => Number(info.size)), Effect.mapError(failed)),
    delete: Effect.fn("AttachmentStorage.delete")((key: string) => fs.remove(pathOf(key), { force: true }), Effect.mapError(failed)),
  };
});
