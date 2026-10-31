import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { FileWriter } from "./files.ts";
import { announce, announced, HomeTaken, leaseHome } from "./lease.ts";

test("a kept file is written whole, and not after it is finished", () => {
  const path = join(tempDir("vibevalley-files-"), "deep", "state.json");
  const w = new FileWriter(path);
  w.write(() => "one");
  expect(readFileSync(path, "utf8")).toBe("one");
  w.finish(() => "last");
  w.write(() => "late");
  expect(readFileSync(path, "utf8")).toBe("last");
});

test("one server per home; a stale lock is taken over", () => {
  const home = tempDir("vibevalley-lease-");
  const release = leaseHome(home);
  expect(() => leaseHome(home)).toThrow(HomeTaken);
  release();
  const again = leaseHome(home);
  again();
  writeFileSync(join(home, ".vibevalley.lock"), "999999");
  leaseHome(home)();
});

test("a server says where it listens in its home while it runs, and a stopped one's word is not taken", () => {
  const home = tempDir("vv-announce-");
  expect(announced(home)).toBeUndefined();
  const withdraw = announce(home, "http://127.0.0.1:56048");
  expect(announced(home)).toBe("http://127.0.0.1:56048");
  withdraw();
  expect(announced(home)).toBeUndefined();
  // Left behind by a server that died: its pid is not running.
  writeFileSync(join(home, "server.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 2 ** 22 + 7 }));
  expect(announced(home)).toBeUndefined();
});
