import { readdir } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { testConfig } from "#/testing/layers.ts";

import { makeStorage } from "./storage.ts";

const bytes = new TextEncoder().encode("a kept file");
// makeStorage takes the key it is given; the caller (Attachment) hashes the bytes.
const key = "d686580a17015eb1824fae75642d75248f1b50ee5147941530f117716243330d";

/** Everything source gives, as text. */
const text = async (source: AsyncIterable<Uint8Array>) => {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of source) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
};

describe("storage on the local disk", () => {
  test("keeps a key once, reads it back, and deletes it", async () => {
    const storage = makeStorage(testConfig());
    await storage.put(key, bytes);
    await storage.put(key, bytes);
    const kept = await readdir(dirname(storage.pathOf(key)));
    expect(kept.filter((name) => name === key)).toEqual([key]);
    const size = await storage.size(key);
    expect(size).toBe(bytes.length);
    const blob = await storage.open(key, "text/plain");
    const read = await blob.text();
    expect([read, blob.type]).toEqual(["a kept file", "text/plain"]);
    await storage.delete(key);
    const gone = await storage.exists(key);
    expect(gone).toBe(false);
  });

  test("a streamed put is published whole, and a cancelled one leaves nothing at its key", async () => {
    const storage = makeStorage(testConfig());
    const other = "0000000000000000000000000000000000000000000000000000000000000000";
    const started = Promise.withResolvers<void>();
    const stop = new AbortController();
    async function* endless() {
      yield bytes;
      started.resolve();
      await new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
    }
    const put = storage.putStream(other, endless(), stop.signal).catch((e: unknown) => e);
    await started.promise;
    stop.abort();
    await put;
    const left = await storage.exists(other);
    expect(left).toBe(false);
    const staged = await readdir(storage.scratch);
    expect(staged).toEqual([]);
    async function* halves() {
      yield bytes.subarray(0, 4);
      yield bytes.subarray(4);
    }
    await storage.putStream(key, halves());
    const read = await text(storage.stream(key));
    expect(read).toBe("a kept file");
  });
});
