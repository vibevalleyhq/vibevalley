// A run makes hundreds of farms, repositories and homes; left behind, they fill the disk.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (made.length === 0) process.once("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
  made.push(dir);
  return dir;
}
