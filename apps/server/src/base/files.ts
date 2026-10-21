// A file the server keeps (state.json…), saved whole or not at all and in order: each
// write goes to a temporary file renamed over it, so a crash never leaves half a file; the last write asked for wins.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
