// A file the server keeps (state.json…), saved whole or not at all and in order: each
// write goes to a temporary file renamed over it, so a crash never leaves half a file; the last write asked for wins.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";

/**
 * An owner's file (config.json, settings.json, state.json) read by read. One that does not read (not JSON, or not the
 * shape this server knows) is moved aside as `<file>.unreadable-<time>` and none is returned: it is never written over,
 * and the owner can take it back. One that cannot be moved aside stops the start. No file is none too.
 */
export const readOrSetAside = <A>(file: string, read: (text: string) => A, startsFrom: string): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    if (!existsSync(file)) return undefined;
    try {
      return read(readFileSync(file, "utf8"));
    } catch (e) {
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch (moved) {
        return yield* Effect.die(new Error(`${file} cannot be read, and could not be kept aside as ${aside}: ${String(moved)}`));
      }
      yield* Effect.logWarning(`${file} could not be read (${String(e)}): kept as ${aside}, ${startsFrom}`);
      return undefined;
    }
  });

export class FileWriter {
  private finished = false;

  constructor(
    private readonly path: string,
    private readonly mode = 0o644,
  ) {}

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
    const temp = join(dirname(this.path), `${basename(this.path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, data, { mode: this.mode });
    renameSync(temp, this.path);
  }
}
