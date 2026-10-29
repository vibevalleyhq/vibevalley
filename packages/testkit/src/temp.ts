// Temporary folders for tests, removed when the test process ends: a run makes hundreds of farms, repositories and
// homes, and left behind they fill the disk.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A new folder under the system's temporary one, named prefix and something random; gone when the process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (made.length === 0) process.once("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
  made.push(dir);
  return dir;
}
