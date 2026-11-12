import { expect, test } from "vite-plus/test";

import type { PublicFetch } from "#/infra/publicHttp.ts";
import { wallTime } from "#/infra/time.ts";
import { png } from "#/modules/media/testdata/png.ts";

import { DownloadFailed, downloadImage } from "./download.ts";
import { validPng } from "./png.ts";

/** A clock whose waits end only when the test says. */
const heldClock = () => {
  const waits: { readonly wake: () => void }[] = [];
  return {
    clock: {
      ...wallTime,
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          waits.push({ wake: resolve });
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
    pass: () => {
      for (const w of waits.splice(0)) w.wake();
    },
  };
};

const headersOf = (init?: RequestInit) => new Headers(init?.headers);

test("PNG validation checks dimensions, CRC, compressed data and complete framing", () => {
  const bytes = png();
  expect(validPng(bytes, 256, 256)).toBe(true);
  expect(validPng(bytes, 512, 256)).toBe(false);
  expect(validPng(bytes.subarray(0, bytes.length - 1), 256, 256)).toBe(false);
  expect(validPng(Buffer.concat([bytes, Buffer.from("trailing")]), 256, 256)).toBe(false);
  bytes[50] = (bytes[50] ?? 0) ^ 1;
  expect(validPng(bytes, 256, 256)).toBe(false);
});

test("downloads send no credentials and return only checked PNG bytes", async () => {
  const bytes = png();
  const fetch: PublicFetch = async (_url, init) => {
    expect(headersOf(init).get("authorization")).toBeNull();
    expect(init?.method ?? "GET").toBe("GET");
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  };
  expect(await downloadImage(fetch, "https://example.com/image.png", 256, 256, { clock: wallTime })).toEqual(bytes);
});

test.each(["https://127.0.0.1/image", "https://[::ffff:7f00:1]/image", "file:///etc/passwd", "http://example.com/image"])(
  "unsafe URL %s is blocked before transport",
  async (url) => {
    const fetch: PublicFetch = () => {
      throw new Error("Unexpected transport");
    };
    const error = await downloadImage(fetch, url, 256, 256, { clock: wallTime }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadFailed);
  },
);

test.each([301, 302, 401, 500])("HTTP %i is not followed or retried", async (status) => {
  let calls = 0;
  const fetch: PublicFetch = async () => {
    calls++;
    return new Response("", { status, headers: { location: "http://127.0.0.1/secret" } });
  };
  expect(await downloadImage(fetch, "https://example.com/image", 256, 256, { clock: wallTime }).catch((e: unknown) => e)).toBeInstanceOf(DownloadFailed);
  expect(calls).toBe(1);
});

test("a stalled image body is canceled at the download deadline", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  let canceled = false;
  const fetch: PublicFetch = async () => {
    start();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "image/png" } },
    );
  };
  const held = heldClock();
  const download = downloadImage(fetch, "https://example.com/image", 256, 256, { clock: held.clock }).catch((e: unknown) => e);
  await started;
  held.pass();
  expect(await download).toBeInstanceOf(DownloadFailed);
  expect(canceled).toBe(true);
});
