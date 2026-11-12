import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { writeOnce } from "./files.ts";

// writeOnce writes into a directory of its own and links the whole file to the hash, so a write cut short (it takes no
// signal: only a crash cuts it) never leaves a partial file at the hash.
test("regression: interrupted attachment writes cannot publish a partial hash-named file", async () => {
  const directory = tempDir("vibevalley-once-");
  const target = join(directory, "hash");
  const bytes = Buffer.from("complete bytes");
  await Promise.all([writeOnce(target, bytes), writeOnce(target, bytes)]);
  const file = await readFile(target);
  expect(Buffer.from(file)).toEqual(bytes);
  await writeOnce(target, Buffer.from("do not replace"));
  const file2 = await readFile(target);
  expect(Buffer.from(file2)).toEqual(bytes);
  const directory3 = await readdir(directory);
  expect(directory3).toEqual(["hash"]);
});
