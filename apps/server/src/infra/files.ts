// A file the server keeps (state.json…), saved whole or not at all and in order: each write goes to a temporary file
// renamed over it, so a crash never leaves half a file; the last write asked for wins. All of it on FileSystem: no write
// holds the event loop while helpers stream.

import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { Clock, Effect, FiberHandle, FileSystem, Schema, Semaphore } from "effect";

import { messageOf } from "@/errors.ts";

export class NotWritten extends Schema.TaggedError<NotWritten, { readonly brand: unique symbol }>()("NotWritten", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const notWritten = (cause: unknown) => new NotWritten({ message: messageOf(cause), cause });

/** Writes a file named by its bytes (their hash), making its folder: the same bytes are the same file, so one already
 * there is left as it is. */
export const writeOnce = (path: string, bytes: Uint8Array): Effect.Effect<void, NotWritten, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs.writeFile(path, bytes, { flag: "wx" }).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
  }).pipe(Effect.mapError(notWritten));

/**
 * An owner's file (config.json, settings.json, state.json) read by read. One that does not read (not JSON, or not the
 * shape this server knows) is moved aside as `<file>.unreadable-<time>` and none is returned: it is never written over,
 * and the owner can take it back. One that cannot be moved aside stops the start. No file is none too.
 */
export const readOrSetAside = <A>(file: string, read: (text: string) => A, startsFrom: string): Effect.Effect<A | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(
      Effect.map((t): string | undefined => t),
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
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
            .pipe(Effect.catch((moved) => Effect.die(new Error(`${file} cannot be read, and could not be kept aside as ${aside}: ${moved.message}`))));
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
  /** Writes the latest body soon (after the wait), the changes in between joining that write; and once more as the
   * scope closes, so the last state is on disk. Safe to call from a callback. */
  readonly soon: (body: () => string) => void;
}

/** soonMs: how long a soon write waits after the first change, so a burst is one write and a crash loses no more. */
export const keptFile = (path: string, options: { readonly mode?: number; readonly soonMs?: number } = {}) =>
  Effect.gen(function* () {
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
