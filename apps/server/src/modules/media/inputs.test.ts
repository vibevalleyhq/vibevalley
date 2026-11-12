import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { mapConcurrent } from "@vibevalley/async";
import { BizCode } from "@vibevalley/protocol/api";

import { refused } from "#/base/errors.ts";
import { keptLog } from "#/infra/log.ts";
import { type Attachment, makeAttachment } from "#/modules/attachment/attachment.ts";
import { wav } from "#/modules/media/testdata/audio.ts";
import { png } from "#/modules/media/testdata/png.ts";
import { testConfig, testDb } from "#/testing/layers.ts";
import * as q from "#db/media_input.sql.ts";

import { diskStorage, type MediaInputStorage } from "./input.ts";
import { type Inputs, makeInputs } from "./inputs.ts";
import { allow, heldTime, hours, refuse } from "./testing.ts";

const notIn = (value: unknown, secret: string) => {
  expect(JSON.stringify(value)).not.toContain(secret);
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was not refused"),
    (e: unknown) => e,
  );

async function* chunks(...parts: readonly Uint8Array[]) {
  for (const part of parts) yield part;
}
/** A source that must never be read. */
const unread = (why: string): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    throw new Error(why);
  },
});
/** Its first parts, then nothing ever again; reading past them says so. */
const stalled = (...first: readonly Uint8Array[]) => {
  const { promise: reading, resolve } = Promise.withResolvers<void>();
  async function* source() {
    for (const part of first) yield part;
    resolve();
    await new Promise<never>(() => undefined);
  }
  return { reading, source: source() };
};
/** A removal the file system refuses. */
const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });

/** Inputs over a fresh database and attachments on a clock the test moves; another Inputs over the same store is as after a restart. */
const aStore = async () => {
  const config = testConfig();
  const db = await testDb(config);
  const held = heldTime();
  const attachment = await makeAttachment({ config, clock: held.time, db });
  const log = keptLog();
  const make = (storage: MediaInputStorage = diskStorage, kept: Attachment = attachment) =>
    makeInputs({ db, clock: held.time, log, attachment: kept }, storage);
  return {
    config,
    db,
    attachment,
    adjust: held.adjust,
    inputs: make(),
    make,
    [Symbol.asyncDispose]: () => db.close(),
  };
};
const keptAt = (home: string, ...parts: string[]) => [home, "attachments", ...parts].join("/");
const bytes = png();
const metadata = { kind: "image", name: "input.png", mime: "image/png", size: bytes.length } as const;
const saved = async (inputs: Inputs) => {
  const input = await inputs.create(metadata);
  return inputs.upload(input.id, chunks(bytes));
};
const capacityOf = async (store: Awaited<ReturnType<typeof aStore>>) => q.inputCapacity(store.db.sql);

test("input reservations are immutable, kept as one attachment, taken from a kept file, and never return private paths", async () => {
  await using store = await aStore();
  const { inputs, config } = store;
  const first = await saved(inputs);
  const second = await saved(inputs);
  expect(first.id).not.toBe(second.id);
  expect((await inputs.previewDelete(first.id)).does).toHaveLength(1);
  expect((await inputs.get(first.id)).phase).toBe("ready");
  expect(first).toMatchObject({ phase: "ready", canDelete: true, hash: second.hash });
  notIn(first, config.home);
  expect(existsSync(keptAt(config.home, first.hash ?? ""))).toBe(true);
  const uploaded = await inputs.upload(first.id, unread("do not read a repeated upload"));
  expect(uploaded).toEqual(first);
  await inputs.delete(first.id);
  expect((await inputs.get(second.id)).phase).toBe("ready");
  expect((await inputs.previewDelete(second.id)).does).toHaveLength(1);
  await inputs.delete(second.id);
  expect(await inputs.previewDelete(second.id)).toEqual({ does: [] });
  await inputs.delete(second.id);
  // Media stops holding it; the attachment stays for whatever else keeps it.
  expect(existsSync(keptAt(config.home, second.hash ?? ""))).toBe(true);
  // A kept file is taken as an input on its own bytes; one that is no image, video or audio is refused.
  const file = await store.attachment.attach({ name: "kept.png", type: "image/png", data: Buffer.from(bytes).toString("base64") });
  const input = await inputs.adopt(file.id);
  expect(input).toMatchObject({ phase: "ready", hash: file.id, kind: "image", mime: "image/png", size: bytes.length });
  const text = await store.attachment.attach({ name: "notes.txt", type: "text/plain", data: Buffer.from("plain words").toString("base64") });
  expect(await failure(inputs.adopt(text.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
});

test("concurrent reservations cannot overbook the byte quota", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => inputs.create({ kind: "video", name: "video.mp4", mime: "video/mp4", size: 200_000_000 })),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  expect(await inputs.list()).toHaveLength(10);
  for (const input of await inputs.list()) await inputs.delete(input.id);
  expect((await inputs.create(metadata)).phase).toBe("reserved");
});

test("reservation count is bounded even for tiny files", async () => {
  await using store = await aStore();
  const { inputs } = store;
  await mapConcurrent(Array.from({ length: 256 }), 16, () => inputs.create(metadata));
  expect(await failure(inputs.create(metadata))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await inputs.list()).toHaveLength(256);
});

test("references survive expiry and restart, and release permits cleanup", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const first = await saved(inputs);
  const unused = await saved(inputs);
  await inputs.pin([first.id], "task-a", async () => undefined);
  expect((await inputs.get(first.id)).canDelete).toBe(false);
  expect(await failure(inputs.delete(first.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(inputs.previewDelete(first.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await store.adjust(hours(24));
  const restarted = store.make();
  await restarted.restore();
  await restarted.sweep();
  expect((await restarted.get(first.id)).phase).toBe("ready");
  expect(await failure(restarted.get(unused.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await restarted.release("task-a");
  await restarted.sweep();
  expect(await restarted.list()).toEqual([]);
});

test("reference acquisition and admission roll back together", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const first = await saved(inputs);
  await failure(inputs.pin([first.id, "missing"], "task-a", async () => undefined));
  expect((await inputs.get(first.id)).canDelete).toBe(true);
  await failure(
    inputs.pin([first.id], "task-b", async () => {
      throw refused("admission failed");
    }),
  );
  expect((await inputs.get(first.id)).canDelete).toBe(true);
  await inputs.pin([first.id, first.id], "task-c", async () => undefined);
  await inputs.release("task-c");
  await inputs.delete(first.id);
});

test("regression: an interrupted upload releases admission and permits an explicit local retry", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const input = await inputs.create(metadata);
  const { reading, source } = stalled(bytes.subarray(0, 32));
  const stop = new AbortController();
  const upload = failure(inputs.upload(input.id, source, stop.signal));
  await reading;
  expect((await inputs.get(input.id)).canDelete).toBe(false);
  expect(await failure(inputs.delete(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(inputs.upload(input.id, chunks(bytes)))).toMatchObject({ bizCode: BizCode.MediaRefused });
  stop.abort();
  await upload;
  expect((await inputs.get(input.id)).phase).toBe("failed");
  expect((await inputs.upload(input.id, chunks(bytes))).canDelete).toBe(true);
});

test("regression: failed partial-file cleanup retains its reservation and cannot accumulate retry files", async () => {
  await using store = await aStore();
  const root = keptAt(store.config.home, "staging", "media");
  let blocked = false;
  const failing: MediaInputStorage = {
    ...diskStorage,
    remove: async (path) => {
      if (blocked && path.startsWith(root + "/")) throw denied();
      await diskStorage.remove(path);
    },
  };
  const inputs = store.make(failing);
  const input = await inputs.create(metadata);
  async function* source() {
    yield bytes.subarray(0, 32);
    blocked = true;
  }
  await failure(inputs.upload(input.id, source()));
  expect((await inputs.get(input.id)).phase).toBe("failed");
  expect(readdirSync(join(root, input.id))).toHaveLength(1);
  expect(await failure(inputs.upload(input.id, unread("must not accept another file")))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await failure(inputs.delete(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await inputs.sweep();
  expect(await inputs.list()).toHaveLength(1);
  blocked = false;
  await inputs.sweep();
  expect(await inputs.list()).toEqual([]);
  expect(existsSync(join(root, input.id))).toBe(false);
});

test("at most eight streams are accepted concurrently and timeout releases every slot", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const active: Promise<unknown>[] = [];
  for (let n = 0; n < 8; n++) {
    const input = await inputs.create(metadata);
    const { reading, source } = stalled();
    active.push(failure(inputs.upload(input.id, source)));
    await reading;
  }
  const next = await inputs.create(metadata);
  expect(await failure(inputs.upload(next.id, chunks(bytes)))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await store.adjust(300_000);
  await Promise.all(active);
  expect((await inputs.upload(next.id, chunks(bytes))).phase).toBe("ready");
});

test("startup removes partial files without repeating any upload", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const input = await inputs.create(metadata);
  const staging = keptAt(store.config.home, "staging", "media");
  mkdirSync(join(staging, ".input-interrupted"), { recursive: true });
  writeFileSync(join(staging, ".input-interrupted/content"), "partial");
  await q.changeInput(store.db.sql, { id: input.id, phase: "uploading", hash: null, expires: input.expiresAt });
  const restarted = store.make();
  await restarted.restore();
  expect((await restarted.get(input.id)).phase).toBe("failed");
  expect(existsSync(staging)).toBe(false);
});

test("regression: repairing a missing saved input cannot replace its original content", async () => {
  await using store = await aStore();
  const input = await saved(store.inputs);
  rmSync(keptAt(store.config.home, input.hash ?? ""));
  const restarted = store.make();
  await restarted.restore();
  expect((await restarted.get(input.id)).phase).toBe("failed");
  const different = Buffer.from(bytes);
  different[20] = 23;
  expect(await failure(restarted.upload(input.id, chunks(different)))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await restarted.upload(input.id, chunks(bytes))).hash).toBe(input.hash);
});

test.each([false, true])("regression: a rejected database commit remains accounted and retryable when rollback is blocked: %s", async (blockRollback) => {
  await using store = await aStore();
  const home = store.config.home;
  const staging = keptAt(home, "staging", "media");
  // Blocked once bytes flow: the cleanup after the failed commit, not the one before the upload starts.
  let blocked = false;
  const failing: MediaInputStorage = {
    ...diskStorage,
    remove: async (path) => {
      if (blocked && path.startsWith(staging + "/")) throw denied();
      await diskStorage.remove(path);
    },
  };
  const inputs = store.make(failing);
  const input = await inputs.create(metadata);
  await refuse(store.db, "media_input_test_fail", "BEFORE UPDATE OF phase ON media_input", "NEW.phase = 'ready'", "injected database failure");
  async function* flowing() {
    blocked = blockRollback;
    yield bytes;
  }
  const error = await failure(inputs.upload(input.id, flowing()));
  expect(error).toMatchObject({ bizCode: BizCode.MediaRefused });
  notIn(error, "injected database failure");
  const failed = await inputs.get(input.id);
  expect(failed).toMatchObject({ phase: "failed" });
  expect(failed.hash).not.toBeNull();
  // The bytes were kept as an attachment before the commit failed; the reservation stays accounted either way.
  expect(existsSync(keptAt(home, failed.hash ?? ""))).toBe(true);
  blocked = false;
  await allow(store.db, "media_input_test_fail");
  expect((await inputs.upload(input.id, chunks(bytes))).phase).toBe("ready");
});

test("failed deletion remains a tombstone and is resumed after restart", async () => {
  await using store = await aStore();
  let blocked = "";
  const failing: MediaInputStorage = {
    ...diskStorage,
    remove: async (path) => {
      if (path === blocked) throw denied();
      await diskStorage.remove(path);
    },
  };
  const inputs = store.make(failing);
  const input = await saved(inputs);
  blocked = join(keptAt(store.config.home, "staging", "media"), input.id);
  expect(await failure(inputs.delete(input.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await inputs.get(input.id)).phase).toBe("deleting");
  expect(await failure(inputs.upload(input.id, chunks(bytes)))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await inputs.create(metadata);
  await store.adjust(hours(24));
  await inputs.sweep();
  expect((await inputs.list()).map((row) => row.id)).toEqual([input.id]);
  const restarted = store.make();
  await restarted.restore();
  await restarted.sweep();
  expect(await restarted.list()).toEqual([]);
  expect(existsSync(blocked)).toBe(false);
});

test("only the retaining task can obtain a checked disk-backed Blob", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const input = await saved(inputs);
  expect(await failure(inputs.blob(input.id, "task-a"))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await inputs.pin([input.id], "task-a", async () => undefined);
  expect(await failure(inputs.blob(input.id, "task-b"))).toMatchObject({ bizCode: BizCode.MediaRefused });
  const blob = await inputs.blob(input.id, "task-a");
  expect([blob.size, blob.type]).toEqual([bytes.length, "image/png"]);
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  await inputs.release("task-a");
  expect(await failure(inputs.blob(input.id, "task-a"))).toMatchObject({ bizCode: BizCode.MediaRefused });
});

test.each(["changed", "truncated", "grown", "missing"])("regression: %s input bytes cannot be sent to a provider", async (broken) => {
  await using store = await aStore();
  const { inputs } = store;
  const input = await saved(inputs);
  const path = keptAt(store.config.home, input.hash ?? "");
  await inputs.pin([input.id], "task-a", async () => undefined);
  const changed = Buffer.from(bytes);
  changed[20] = 23;
  if (broken === "missing") rmSync(path);
  else writeFileSync(path, broken === "changed" ? changed : broken === "truncated" ? bytes.subarray(0, 20) : Buffer.concat([bytes, bytes]));
  const error = await failure(inputs.blob(input.id, "task-a"));
  expect(error).toMatchObject({ bizCode: BizCode.MediaRefused });
  notIn(error, path);
  expect((await inputs.get(input.id)).phase).toBe("failed");
  expect((await inputs.upload(input.id, chunks(bytes))).phase).toBe("ready");
  const repaired = await inputs.blob(input.id, "task-a");
  expect(Buffer.from(await repaired.arrayBuffer())).toEqual(bytes);
});

test("regression: retained audio content remains playable after expiry while unretained and corrupt inputs cannot be read", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const bytes = wav();
  const metadata = { kind: "audio", name: "sample.wav", mime: "audio/wav", size: bytes.length } as const;
  const first = await inputs.create(metadata);
  const second = await inputs.create(metadata);
  await inputs.upload(first.id, chunks(bytes.subarray(0, 5), bytes.subarray(5)));
  await inputs.upload(second.id, chunks(bytes));
  await inputs.pin([first.id], "transcript", async () => undefined);
  await store.adjust(hours(25));
  expect(await failure(inputs.content(second.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  const content = await inputs.content(first.id);
  expect(content).toMatchObject({ mime: "audio/wav", size: bytes.length, name: "sample.wav" });
  writeFileSync(content.path, Buffer.alloc(bytes.length));
  const error = await failure(inputs.content(first.id));
  expect(error).toMatchObject({ bizCode: BizCode.MediaRefused });
  notIn(error, content.path);
});

test("regression: generated raw PCM uses the hash store without inventing metadata or weakening public uploads", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const source = Uint8Array.of(1, 2, 3, 4);
  expect(await failure(inputs.create({ kind: "audio", name: "raw.pcm", mime: "audio/pcm", size: source.length }))).toMatchObject({
    bizCode: BizCode.MediaRefused,
  });
  const first = await (async () => {
    await using staged = await inputs.stageResult("raw.pcm", "pcm", chunks(source));
    expect(staged.metadata).toBeUndefined();
    return await inputs.storeResult(staged, "first");
  })();
  const second = await (async () => {
    await using staged = await inputs.stageResult("raw.pcm", "pcm", chunks(source));
    return await inputs.storeResult(staged, "second");
  })();
  expect(first.hash).toBe(second.hash);
  const home = store.config.home;
  expect(existsSync(keptAt(home, first.hash))).toBe(true);
  expect(readdirSync(keptAt(home, "staging", "media"))).toEqual([]);
  expect((await inputs.content(first.id)).mime).toBe("audio/pcm");
  await inputs.release("unrelated");
  expect((await inputs.get(first.id)).canDelete).toBe(false);
  await inputs.release("first");
  await inputs.delete(first.id);
  expect((await inputs.content(second.id)).size).toBe(source.length);
  expect((await capacityOf(store))?.bytes).toBe(source.length);
});

test("regression: generated staging observes reserved quota and releases failed temporary bytes", async () => {
  await using store = await aStore();
  const { inputs } = store;
  for (let index = 0; index < 4; index++) await inputs.create({ kind: "audio", name: `reserved-${index}.wav`, mime: "audio/wav", size: 512_000_000 });
  await inputs.create({ kind: "audio", name: "remainder.wav", mime: "audio/wav", size: 2 * 1024 * 1024 * 1024 - 4 * 512_000_000 - 4 });
  const resultStagedFailure = await failure(
    (async () => {
      await using _staged = await inputs.stageResult("too-large.pcm", "pcm", chunks(new Uint8Array(5)));
    })(),
  );
  expect(resultStagedFailure).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(readdirSync(keptAt(store.config.home, "staging", "media"))).toEqual([]);
  const result = await (async () => {
    await using staged = await inputs.stageResult("fits.pcm", "pcm", chunks(new Uint8Array(4)));
    return await inputs.storeResult(staged, "fits");
  })();
  expect((await inputs.content(result.id)).size).toBe(4);
  expect((await capacityOf(store))?.bytes).toBe(2 * 1024 * 1024 * 1024);
});

test("regression: failed generated-result promotion rolls back rows, pins, and temporary files", async () => {
  await using store = await aStore();
  // Keeping the staged file fails as a rename refused by the disk would.
  const failing: Attachment = {
    ...store.attachment,
    keepStaged: async () => {
      throw refused("rename refused");
    },
  };
  const inputs = store.make(diskStorage, failing);
  {
    await using staged = await inputs.stageResult("sample.wav", "wav", chunks(wav()));
    expect(await failure(inputs.storeResult(staged, "failed"))).toMatchObject({ bizCode: BizCode.MediaRefused });
  }
  expect(await inputs.list()).toEqual([]);
  const home = store.config.home;
  expect(readdirSync(keptAt(home, "staging", "media"))).toEqual([]);
  expect(readdirSync(keptAt(home)).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([]);
});

test("regression: explicit asset release preserves shared pins and content until the final holder releases quota", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const nothing = async () => undefined;
  const first = await saved(inputs);
  const sharedContent = await saved(inputs);
  await inputs.pin([first.id], "job-a", nothing);
  await inputs.pin([first.id], "job-b", nothing);
  await inputs.pin([sharedContent.id], "job-c", nothing);
  await store.adjust(hours(25));
  await inputs.sweep();
  expect((await capacityOf(store))?.bytes).toBe(bytes.length * 2);
  await inputs.releaseAssets([first.id], ["job-a"], nothing);
  expect((await inputs.get(first.id)).canDelete).toBe(false);
  expect((await inputs.blob(first.id, "job-b")).size).toBe(bytes.length);
  expect(await failure(inputs.blob(first.id, "job-a"))).toMatchObject({ bizCode: BizCode.MediaRefused });
  await inputs.releaseAssets([first.id], ["job-b"], nothing);
  expect(await failure(inputs.get(first.id))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect((await inputs.content(sharedContent.id)).size).toBe(bytes.length);
  expect((await capacityOf(store))?.bytes).toBe(bytes.length);
  await inputs.releaseAssets([sharedContent.id], ["job-c"], nothing);
  expect(await capacityOf(store)).toEqual({ bytes: 0, count: 0 });
  expect((await inputs.create(metadata)).phase).toBe("reserved");
});

test("regression: failed reference clearing rolls back asset pins and leaves bytes readable", async () => {
  await using store = await aStore();
  const { inputs } = store;
  const input = await saved(inputs);
  await inputs.pin([input.id], "job", async () => undefined);
  const assetsReleasedFailure = await failure(
    inputs.releaseAssets([input.id], ["job"], async () => {
      throw refused("clear failed");
    }),
  );
  expect(assetsReleasedFailure).toMatchObject({ bizCode: BizCode.Refused, message: "clear failed" });
  expect((await inputs.get(input.id)).canDelete).toBe(false);
  expect((await inputs.blob(input.id, "job")).size).toBe(bytes.length);
});

test("regression: failed explicit unlink keeps a quota-accounted tombstone for restart cleanup", async () => {
  await using store = await aStore();
  let blocked = "";
  const failing: MediaInputStorage = {
    ...diskStorage,
    remove: async (path) => {
      if (path === blocked) throw denied();
      await diskStorage.remove(path);
    },
  };
  const inputs = store.make(failing);
  const input = await saved(inputs);
  await inputs.pin([input.id], "job", async () => undefined);
  blocked = join(keptAt(store.config.home, "staging", "media"), input.id);
  expect(await failure(inputs.releaseAssets([input.id], ["job"], async () => undefined))).toMatchObject({ bizCode: BizCode.MediaRefused });
  expect(await inputs.get(input.id)).toMatchObject({ phase: "deleting", canDelete: true });
  expect(await capacityOf(store)).toEqual({ bytes: bytes.length, count: 1 });
  blocked = "";
  const restarted = store.make();
  await restarted.restore();
  await restarted.sweep();
  expect(await capacityOf(store)).toEqual({ bytes: 0, count: 0 });
});
