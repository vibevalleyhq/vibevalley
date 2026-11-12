import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { attachmentMax, type MediaAudioFormat } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { keptLog } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import { type Time, wallTime } from "#/infra/time.ts";
import { makeAttachment } from "#/modules/attachment/attachment.ts";
import { mp3, wav } from "#/modules/media/testdata/audio.ts";
import { testConfig, testDb } from "#/testing/layers.ts";

import { saveAudioResult } from "./audioResult.ts";
import { audioResultMax } from "./input.ts";
import { makeInputs } from "./inputs.ts";

const answer =
  (bytes: Buffer, type: string, headers: Record<string, string> = {}): PublicFetch =>
  async () =>
    new Response(bytes, { headers: { "content-type": type, ...headers } });

const downloadSpeech = async (url: string, format: MediaAudioFormat, publicFetch: PublicFetch, clock: Time = wallTime) => {
  const config = testConfig();
  await using db = await testDb(config);
  const log = keptLog();
  const files = await makeAttachment({ config, clock, db });
  const inputs = makeInputs({ db, clock, log, attachment: files });
  const result = await saveAudioResult({ publicFetch, files, log, clock }, "download-test", url, format, inputs);
  expect(result.resultInput).toBeNull();
  if (!result.attachment) throw new Error("Expected a small attachment");
  const attachment = await files.get(result.attachment.id);
  if (!attachment) throw new Error("Missing saved attachment");
  return readFileSync(attachment.path);
};

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => new Error("it did not fail"),
    (e: unknown) => e,
  );

/** A clock whose waits end only when the test says. */
const heldClock = () => {
  const waits: (() => void)[] = [];
  const clock: Time = {
    ...wallTime,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        waits.push(resolve);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  return {
    clock,
    pass: () => {
      for (const wake of waits.splice(0)) wake();
    },
  };
};

test.each(["wav", "mp3"] as const)("downloads complete %s audio without credentials", async (format) => {
  const bytes = format === "wav" ? wav() : mp3;
  const type = format === "wav" ? "audio/wav" : "audio/mpeg";
  const fetch: PublicFetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    expect(init?.method ?? "GET").toBe("GET");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    return new Response(bytes, { headers: { "content-type": type } });
  };
  expect(await downloadSpeech(`https://audio.example.com/result.${format}?token=private`, format, fetch)).toEqual(bytes);
});

test.each([
  "https://127.0.0.1/audio",
  "https://10.0.0.1/audio",
  "https://[::ffff:7f00:1]/audio",
  "https://user:password@example.com/audio",
  "https://example.com:444/audio",
  "http://example.com/audio",
  "file:///etc/passwd",
])("unsafe speech URL %s never reaches transport", async (address) => {
  const fetch: PublicFetch = () => {
    throw new Error("Unsafe audio URL reached transport");
  };
  expect(await refusal(downloadSpeech(address, "wav", fetch))).toMatchObject({ bizCode: BizCode.MediaRefused });
});

test.each([301, 302, 401, 404, 503])("HTTP %i neither follows redirects nor retries speech downloads", async (status) => {
  let calls = 0;
  const fetch: PublicFetch = async () => {
    calls++;
    return new Response(null, { status, headers: { location: "https://127.0.0.1/private" } });
  };
  await refusal(downloadSpeech("https://audio.example.com/result.wav", "wav", fetch));
  expect(calls).toBe(1);
});

test("regression: WAV framing, sample alignment and the declared codec must agree", async () => {
  const original = wav();
  const badRate = Buffer.from(original);
  badRate.writeUInt32LE(1, 28);
  const badCodec = Buffer.from(original);
  badCodec.writeUInt16LE(7, 20);
  const badBlock = Buffer.from(original);
  badBlock.writeUInt16LE(3, 32);
  const partialSample = Buffer.from(original.subarray(0, original.length - 1));
  partialSample.writeUInt32LE(partialSample.length - 8, 4);
  partialSample.writeUInt32LE(partialSample.length - 44, 40);
  for (const bytes of [
    original.subarray(0, 43),
    original.subarray(0, original.length - 1),
    Buffer.concat([original, Buffer.from("trailing")]),
    badRate,
    badCodec,
    badBlock,
    partialSample,
  ]) {
    expect(await refusal(downloadSpeech("https://audio.example.com/result.wav", "wav", answer(bytes, "audio/wav")))).toBeInstanceOf(Error);
  }
});

test("regression: WAV chunk padding and extensible PCM are validated", async () => {
  const original = wav();
  const extensible = Buffer.concat([original.subarray(0, 36), Buffer.alloc(24), original.subarray(36)]);
  extensible.writeUInt32LE(extensible.length - 8, 4);
  extensible.writeUInt32LE(40, 16);
  extensible.writeUInt16LE(0xfffe, 20);
  extensible.writeUInt16LE(22, 36);
  extensible.writeUInt16LE(16, 38);
  extensible.writeUInt32LE(4, 40);
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(extensible, 44);
  const padded = Buffer.concat([original.subarray(0, 36), Buffer.from("4a554e4b010000000000", "hex"), original.subarray(36)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  expect(await downloadSpeech("https://audio.example.com/pcm.wav", "wav", answer(extensible, "audio/x-wav"))).toEqual(extensible);
  expect(await downloadSpeech("https://audio.example.com/padded.wav", "wav", answer(padded, "audio/wave"))).toEqual(padded);
  extensible[59] = 0;
  expect(await refusal(downloadSpeech("https://audio.example.com/bad.wav", "wav", answer(extensible, "audio/wav")))).toBeInstanceOf(Error);
});

test("regression: MP3 frames and metadata must be complete rather than just start with a signature", async () => {
  const invalidHeader = Buffer.from(mp3);
  invalidHeader[2] = 0;
  const tagged = Buffer.concat([Buffer.from("49443304000000000000", "hex"), mp3, Buffer.from("TAG"), Buffer.alloc(125)]);
  const invalidTag = Buffer.from(tagged);
  invalidTag[6] = 128;
  expect(await downloadSpeech("https://audio.example.com/tagged.mp3", "mp3", answer(tagged, "audio/mp3"))).toEqual(tagged);
  for (const bytes of [
    mp3.subarray(0, 4),
    mp3.subarray(0, mp3.length - 1),
    Buffer.concat([mp3, Buffer.from("trailing")]),
    invalidHeader,
    invalidTag,
    tagged.subarray(0, 10),
  ]) {
    expect(await refusal(downloadSpeech("https://audio.example.com/bad.mp3", "mp3", answer(bytes, "audio/mpeg")))).toBeInstanceOf(Error);
  }
});

test("regression: format, MIME, declared length and actual audio must match", async () => {
  const refused = async (format: MediaAudioFormat, fetch: PublicFetch) =>
    expect(await refusal(downloadSpeech(`https://audio.example.com/result.${format}`, format, fetch))).toBeInstanceOf(Error);
  await refused("wav", answer(mp3, "audio/wav"));
  await refused("mp3", answer(wav(), "audio/mpeg"));
  await refused("wav", answer(wav(), "text/html"));
  await refused("wav", answer(wav(), "audio/wav", { "content-length": "44" }));
  await refused("wav", answer(wav(), "audio/wav", { "content-length": String(audioResultMax + 1) }));
  await refused("wav", answer(Buffer.alloc(attachmentMax + 1), "audio/wav"));
});

test("a stalled speech body is canceled at the download deadline", async () => {
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  // The body's cancel comes after the download has given up, on the stream's own turn.
  const { promise: canceled, resolve: cancel } = Promise.withResolvers<void>();
  const fetch: PublicFetch = async () => {
    start();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancel();
        },
      }),
      { headers: { "content-type": "audio/wav" } },
    );
  };
  const held = heldClock();
  const download = refusal(downloadSpeech("https://audio.example.com/result.wav", "wav", fetch, held.clock));
  await started;
  held.pass();
  expect(await download).toMatchObject({ bizCode: BizCode.MediaRefused });
  await canceled;
});
