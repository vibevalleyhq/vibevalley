import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Clock, Effect, FiberHandle, FileSystem, PlatformError, Schema, Semaphore } from "effect";

import { Inconsistent, messageOf } from "#/base/errors.ts";

// FileSystem has no Blob adapter; the native Blob keeps multipart uploads disk-backed rather than buffering the file.
export const fileBlob = Effect.fn("Files.blob")((path: string, type: string) =>
  Effect.tryPromise({
    try: () => openAsBlob(path, { type }),
    catch: (cause) => PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "openAsBlob", pathOrDescriptor: path, cause }),
  }),
);

export class NotWritten extends Schema.TaggedError<NotWritten, { readonly brand: unique symbol }>()("NotWritten", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const notWritten = (cause: unknown) => new NotWritten({ message: messageOf(cause), cause });

// Publish hash-named files only after writing all bytes; cancellation must not leave a partial file at the hash.
export const writeOnce = Effect.fn("Files.writeOnce")(function* (path: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ directory: dirname(path), prefix: ".upload-" });
      const temporary = join(directory, "asset");
      yield* fs.writeFile(temporary, bytes, { mode: 0o600 });
      yield* fs.link(temporary, path).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
    }),
  );
}, Effect.mapError(notWritten));

/** An owner's file (config.json, settings.json) read by read. */
export const readOrSetAside = <A>(file: string, read: (text: string) => A, startsFrom: string): Effect.Effect<A | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(
      Effect.map((t): string | undefined => t),
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
      Effect.orDie,
    );
    if (text === undefined) return undefined;
    return yield* Effect.try({ try: () => read(text), catch: messageOf }).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (failure) {
          const aside = `${file}.unreadable-${yield* Clock.currentTimeMillis}`;
          yield* fs
            .rename(file, aside)
            .pipe(
              Effect.catch((moved) =>
                Effect.die(new Inconsistent({ message: `${file} cannot be read, and could not be kept aside as ${aside}: ${moved.message}` })),
              ),
            );
          yield* Effect.logWarning(`${file} could not be read (${failure}): kept as ${aside}, ${startsFrom}`);
          return undefined;
        }),
      ),
    );
  });

/** A file kept by the server: one write at a time, the last asked for wins. */
export interface KeptFile {
  /** Writes body now, after the write in flight: what is kept only once it is on disk (a profile, a setting). */
  readonly save: (body: string) => Effect.Effect<void, NotWritten>;
  /** Writes the latest body soon (after the wait), the changes in between joining that write. and once more as the scope closes, so the last state is on disk. */
  readonly soon: (body: () => string) => void;
}

/** soonMs: how long a soon write waits after the first change, so a burst is one write and a crash loses no more. */
export const keptFile = Effect.fn("Files.keptFile")(function* (path: string, options: { readonly mode?: number; readonly soonMs?: number } = {}) {
  const fs = yield* FileSystem.FileSystem;
  const one = yield* Semaphore.make(1);
  const write = (data: string) =>
    one.withPermits(1)(
      Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
        yield* fs.writeFileString(temp, data, { mode: options.mode ?? 0o644 });
        yield* fs.rename(temp, path);
      }).pipe(Effect.mapError(notWritten)),
    );
  let pending: (() => string) | undefined;
  const flush = Effect.suspend(() => {
    const body = pending;
    pending = undefined;
    return body ? write(body()) : Effect.void;
  }).pipe(Effect.catch((e) => Effect.logError(`vibevalley: ${path} could not be saved`, e)));
  const waiting = yield* FiberHandle.make();
  const start = yield* FiberHandle.runtime(waiting)();
  // Added before the finalizers of the service that keeps it, so it runs after them: its state as it leaves it.
  yield* Effect.addFinalizer(() => Effect.andThen(FiberHandle.clear(waiting), flush));
  return {
    save: (body) =>
      Effect.suspend(() => {
        pending = undefined;
        return write(body);
      }),
    soon: (body) => {
      pending = body;
      start(Effect.delay(flush, options.soonMs ?? 0), { onlyIfMissing: true });
    },
  } satisfies KeptFile;
});
