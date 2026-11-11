import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vite-plus/test";

import { commandLine } from "./commandLine";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the command line is linked into ~/.local/bin and taken back out; another's file there is left alone", () => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
  const bin = join(dir, ".local", "bin");
  const launcher = join(dir, "VibeValley.app", "Contents", "Resources", "bin", "vibevalley");
  mkdirSync(join(launcher, ".."), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\n");
  const keptPath = join(dir, "shell-path");
  writeFileSync(keptPath, `/usr/bin:${bin}`);
  const cli = commandLine({ command: "vibevalley", launcher, bin, keptPath });
  expect(cli.state()).toMatchObject({ installed: false, onPath: true, taken: false });
  expect(cli.install()).toMatchObject({ installed: true, link: join(bin, "vibevalley") });
  expect(cli.install()).toMatchObject({ installed: true });
  expect(cli.remove()).toMatchObject({ installed: false, taken: false });

  writeFileSync(join(bin, "vibevalley"), "someone else's\n");
  expect(cli.state()).toMatchObject({ installed: false, taken: true });
  expect(() => cli.install()).toThrow();
  writeFileSync(keptPath, "/usr/bin");
  expect(cli.state().onPath).toBe(false);
});
