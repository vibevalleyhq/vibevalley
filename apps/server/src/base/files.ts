// A file the server keeps (state.json…), saved whole or not at all and in order: each
// write goes to a temporary file renamed over it, so a crash never leaves half a file; the last write asked for wins.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Clock, Data, Effect } from "effect";

import { errnoOf, messageOf } from "@/errors.ts";

export class NotWritten extends Data.TaggedError("NotWritten")<{ readonly message: string; readonly cause: unknown }> {}

const notWritten = (cause: unknown) => new NotWritten({ message: messageOf(cause), cause });

/** Writes a file named by its bytes (their hash), making its folder: the same bytes are the same file, so one already
 * there is left as it is. */
export const writeOnce = (path: string, bytes: Uint8Array): Effect.Effect<void, NotWritten> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: notWritten });
    yield* Effect.tryPromise({ try: () => writeFile(path, bytes, { flag: "wx" }), catch: notWritten }).pipe(
      Effect.catchIf(
        (e) => errnoOf(e.cause) === "EEXIST",
        () => Effect.void,
      ),
    );
  });

/**
 * An owner's file (config.json, settings.json, state.json) read by read. One that does not read (not JSON, or not the
 * shape this server knows) is moved aside as `<file>.unreadable-<time>` and none is returned: it is never written over,
 * and the owner can take it back. One that cannot be moved aside stops the start. No file is none too.
 */
export const readOrSetAside = <A>(file: string, read: (text: string) => A, startsFrom: string): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    if (!existsSync(file)) return undefined;
    const got = yield* Effect.result(Effect.try({ try: () => read(readFileSync(file, "utf8")), catch: messageOf }));
    if (got._tag === "Success") return got.success;
    const aside = `${file}.unreadable-${yield* Clock.currentTimeMillis}`;
    yield* Effect.try({ try: () => renameSync(file, aside), catch: messageOf }).pipe(
      Effect.catch((moved) => Effect.die(new Error(`${file} cannot be read, and could not be kept aside as ${aside}: ${moved}`))),
    );
    yield* Effect.logWarning(`${file} could not be read (${got.failure}): kept as ${aside}, ${startsFrom}`);
    return undefined;
  });

export class FileWriter {
  private finished = false;

  private readonly path: string;
  private readonly mode: number;
  constructor(path: string, mode: number = 0o644) {
    this.path = path;
    this.mode = mode;
  }

  /** body is asked when this write's turn comes: the state as it is then. */
  write(body: () => string) {
    if (!this.finished) this.save(body());
  }

  /** Writes the last snapshot and seals the writer: a timer still pending cannot write after it. */
  finish(body: () => string) {
    if (this.finished) return;
    this.finished = true;
    this.save(body());
  }

  private save(data: string) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `${basename(this.path)}.${randomUUID()}.tmp`);
    writeFileSync(temp, data, { mode: this.mode });
    renameSync(temp, this.path);
  }
}
