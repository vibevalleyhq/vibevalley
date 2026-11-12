import { createHash } from "node:crypto";

import { expect, test } from "vite-plus/test";

import { mediaInputContentPath } from "@vibevalley/protocol";
import { apiSuccessEnvelope } from "@vibevalley/protocol/api";
import { MediaInput } from "@vibevalley/protocol/schema";

import { png } from "#/modules/media/testdata/png.ts";
import { app } from "#/testing/http.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

const decodeMediaInput = async (res: Response) => apiSuccessEnvelope(MediaInput).parse(await res.json()).data;

const octets = { "content-type": "application/octet-stream" };

/** The whole farm on a free port, and how a page calls it; closed with the test. */
const farm = async () => {
  const served = await app(testConfig(), 0, undefined, quietApp);
  const base = `http://${served.address}`;
  const post = (op: string, body: unknown) =>
    fetch(`${base}/api/v1/${op.replaceAll(".", "/")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = async (id: string) => decodeMediaInput(await post("media.input.get", { id }));
  return { base, post, get, [Symbol.asyncDispose]: () => served.close() };
};

test("raw input upload is user-only, immutable, and separate from JSON attachments", async () => {
  await using f = await farm();
  const { base, post } = f;
  const bytes = png();
  const metadata = { kind: "image", mime: "image/png", name: "image.png", size: bytes.length };
  const input = await decodeMediaInput(await post("media.input.create", metadata));
  expect(input.phase).toBe("reserved");
  const url = base + mediaInputContentPath(input.id);
  expect((await fetch(url, { method: "PUT", body: bytes, headers: { ...octets, origin: "https://untrusted.example" } })).status).toBe(403);
  expect((await fetch(url, { method: "PUT", body: "not binary", headers: { "content-type": "text/plain" } })).status).toBe(415);
  const ready = await decodeMediaInput(await fetch(url, { method: "PUT", body: bytes, headers: octets }));
  expect(ready).toMatchObject({ phase: "ready", canDelete: true, hash: createHash("sha256").update(bytes).digest("hex") });
  expect(ready).not.toHaveProperty("path");
  const downloaded = await fetch(url);
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  expect((await fetch(url, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
  const part = await fetch(url, { headers: { range: "bytes=4-15" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 4-15/${bytes.length}`);
  expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(4, 16));
  expect((await fetch(url, { headers: { range: `bytes=${bytes.length}-` } })).status).toBe(416);
  expect((await fetch(url, { headers: { range: "bytes=0-1,4-5" } })).status).toBe(416);
  expect((await post("media.input.delete", { id: input.id })).status).toBe(200);
  expect((await post("media.input.get", { id: input.id })).status).toBe(409);
  expect((await post("media.input.create", { ...metadata, size: 30_000_001 })).status).toBe(400);
});

test("binary transport accepts a streamed video container larger than the channel attachment limit", async () => {
  await using f = await farm();
  const { base, post } = f;
  const size = 26 * 1024 * 1024;
  const first = new Uint8Array(64 * 1024);
  first.set(Buffer.from("000000106674797069736f6d00000000", "hex"));
  const zeros = new Uint8Array(first.length);
  const hash = createHash("sha256");
  let index = 0;
  const source = new ReadableStream<Uint8Array>({
    pull: (c) => {
      if (index >= size / first.length) return c.close();
      const chunk = index === 0 ? first : zeros;
      index++;
      hash.update(chunk);
      c.enqueue(chunk);
    },
  });
  const input = await decodeMediaInput(await post("media.input.create", { kind: "video", mime: "video/mp4", name: "transport-fixture.mp4", size }));
  // Node's fetch takes duplex for a streamed body.
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    body: source,
    duplex: "half",
    headers: { ...octets, "content-length": String(size) },
  };
  const ready = await decodeMediaInput(await fetch(base + mediaInputContentPath(input.id), init));
  expect(ready).toMatchObject({ phase: "ready", size, hash: hash.digest("hex") });
});

test("regression: disconnecting a real HTTP upload fails locally and leaves its reservation retryable", async () => {
  await using f = await farm();
  const { base, post, get } = f;
  const bytes = png();
  const input = await decodeMediaInput(await post("media.input.create", { kind: "image", mime: "image/png", name: "input.png", size: bytes.length }));
  const reading = Promise.withResolvers<void>();
  let sent = false;
  const source = new ReadableStream<Uint8Array>({
    pull: async (c) => {
      if (!sent) {
        sent = true;
        return c.enqueue(bytes.subarray(0, 32));
      }
      reading.resolve();
      // Never more: the upload waits until its caller goes away.
      await new Promise<never>(() => {});
    },
  });
  const away = new AbortController();
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    body: source,
    duplex: "half",
    headers: { ...octets, "content-length": String(bytes.length) },
    signal: away.signal,
  };
  const uploading = fetch(base + mediaInputContentPath(input.id), init).catch((e: unknown) => e);
  await reading.promise;
  await waitFor(
    () => get(input.id),
    (row) => row.phase === "uploading",
    "upload admitted",
  );
  away.abort();
  await uploading;
  await waitFor(
    () => get(input.id),
    (row) => row.phase === "failed",
    "disconnected input failed",
  );
  const ready = await decodeMediaInput(await fetch(base + mediaInputContentPath(input.id), { method: "PUT", body: bytes, headers: octets }));
  expect(ready.phase).toBe("ready");
});
