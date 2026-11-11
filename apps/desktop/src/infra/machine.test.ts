import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vite-plus/test";

import { claimMachine, releaseMachine } from "./machine";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the first channel opened keeps the Mac's shortcut and island; a gone one's are taken over", () => {
  dir = mkdtempSync(join(tmpdir(), "machine-"));
  const file = join(dir, "owner");
  expect(claimMachine("VibeValley Beta", file)).toEqual({ mine: true, owner: "VibeValley Beta" });
  // Another running process (this test's parent) has them.
  writeFileSync(file, `${process.ppid} VibeValley\n`);
  expect(claimMachine("VibeValley Beta", file)).toEqual({ mine: false, owner: "VibeValley" });
  releaseMachine(file);
  expect(claimMachine("VibeValley Beta", file).mine).toBe(false);
  // A process that is gone: 2^22 is past any pid macOS hands out.
  writeFileSync(file, `${2 ** 22} VibeValley\n`);
  expect(claimMachine("VibeValley Beta", file)).toEqual({ mine: true, owner: "VibeValley Beta" });
  releaseMachine(file);
  expect(claimMachine("VibeValley Alpha", file).mine).toBe(true);
});
