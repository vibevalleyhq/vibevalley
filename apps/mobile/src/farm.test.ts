import { beforeEach, expect, test, vi } from "vite-plus/test";
import { FarmConnection } from "./farm";

const storage = vi.hoisted(() => ({
  text: null as string | null,
  get: vi.fn<() => Promise<string | null>>(),
  set: vi.fn<(key: string, text: string) => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: storage.get, setItemAsync: storage.set, deleteItemAsync: storage.remove }));

const requests = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>();
const signals = new Map<string, AbortSignal>();
const link = (farm: string) => ({ url: `http://${farm}`, code: farm });
const reply = (farm: string) => requests.get(`http://${farm}/api/v1/lan/pair`)!.resolve(Response.json({ key: `key-${farm}`, hostName: farm }));
const saved = (farm: string) => JSON.stringify({ url: `http://${farm}`, key: `key-${farm}`, hostName: farm });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  storage.text = null;
  requests.clear();
  signals.clear();
  vi.resetAllMocks();
  storage.get.mockImplementation(async () => storage.text);
  storage.set.mockImplementation(async (_key, text) => {
    storage.text = text;
  });
  storage.remove.mockImplementation(async () => {
    storage.text = null;
  });
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const result = Promise.withResolvers<Response>();
    requests.set(url, result);
    signals.set(url, init.signal!);
    return result.promise;
  });
});

test("the later farm choice survives an earlier pairing reply", async () => {
  const farm = new FarmConnection("phone");
  await farm.start();
  farm.select(link("a"));
  const old = farm.pair();
  farm.select(link("b"));
  const latest = farm.pair();
  reply("b");
  await latest;
  reply("a");
  await old;
  expect(farm.snapshot()).toMatchObject({ kind: "farm", farm: { url: "http://b" } });
  expect(JSON.parse(storage.text!).url).toBe("http://b");
  expect(signals.get("http://a/api/v1/lan/pair")?.aborted).toBe(true);
});

test("forgetting a farm prevents a pending pairing from saving it again", async () => {
  const farm = new FarmConnection("phone");
  await farm.start();
  farm.select(link("a"));
  const pending = farm.pair();
  await farm.forget();
  reply("a");
  await pending;
  expect(storage.text).toBeNull();
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", asking: false });
});

test("a failed keychain write does not publish a paired farm", async () => {
  const farm = new FarmConnection("phone");
  await farm.start();
  storage.set.mockRejectedValueOnce(new Error("keychain unavailable"));
  farm.select(link("a"));
  const pairing = farm.pair();
  reply("a");
  await pairing;
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", asking: false, problem: expect.stringContaining("keychain unavailable") });
  expect(storage.text).toBeNull();
});

test("an initial keychain read cannot replace a newer pairing choice", async () => {
  const reading = Promise.withResolvers<string | null>();
  storage.get.mockReturnValueOnce(reading.promise);
  const farm = new FarmConnection("phone");
  const starting = farm.start();
  farm.select(link("b"));
  const pairing = farm.pair();
  reply("b");
  await settle();
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", link: link("b"), asking: true });
  reading.resolve(saved("old"));
  await starting;
  await pairing;
  expect(farm.snapshot()).toMatchObject({ kind: "farm", farm: { url: "http://b" } });
  expect(storage.text).toBe(saved("b"));
});

test("a superseded keychain write finishes before the newer choice is committed", async () => {
  const writing = Promise.withResolvers<void>();
  storage.set.mockImplementationOnce(async (_key, text) => {
    await writing.promise;
    storage.text = text;
  });
  const farm = new FarmConnection("phone");
  await farm.start();
  const published: string[] = [];
  farm.subscribe(() => {
    const choice = farm.snapshot();
    if (choice.kind === "farm") published.push(choice.farm.url);
  });
  farm.select(link("a"));
  const old = farm.pair();
  reply("a");
  await settle();
  farm.select(link("b"));
  const latest = farm.pair();
  reply("b");
  writing.resolve();
  await Promise.all([old, latest]);
  expect(storage.text).toBe(saved("b"));
  expect(published).toEqual(["http://b"]);
});

test("cancel returns to the committed farm after an already-started keychain write", async () => {
  storage.text = saved("old");
  const farm = new FarmConnection("phone");
  await farm.start();
  const writing = Promise.withResolvers<void>();
  storage.set.mockImplementationOnce(async (_key, text) => {
    await writing.promise;
    storage.text = text;
  });
  farm.select(link("a"));
  const pairing = farm.pair();
  reply("a");
  await settle();
  const cancelled = farm.cancel();
  writing.resolve();
  await Promise.all([pairing, cancelled]);
  expect(storage.text).toBe(saved("old"));
  expect(farm.snapshot()).toMatchObject({ kind: "farm", farm: { url: "http://old" } });
});

test("forget waits out an already-started pairing write and removes the durable choice", async () => {
  const farm = new FarmConnection("phone");
  await farm.start();
  const writing = Promise.withResolvers<void>();
  storage.set.mockImplementationOnce(async (_key, text) => {
    await writing.promise;
    storage.text = text;
  });
  farm.select(link("a"));
  const pairing = farm.pair();
  reply("a");
  await settle();
  const forgotten = farm.forget();
  writing.resolve();
  await Promise.all([pairing, forgotten]);
  expect(storage.text).toBeNull();
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", asking: false });
});

test("leaving pairing aborts its request and ignores a late successful reply", async () => {
  const farm = new FarmConnection("phone");
  await farm.start();
  farm.select(link("a"));
  const pairing = farm.pair();
  farm.close();
  expect(signals.get("http://a/api/v1/lan/pair")?.aborted).toBe(true);
  reply("a");
  await pairing;
  expect(storage.text).toBeNull();
});

test("forget reports a keychain failure and can be retried", async () => {
  storage.text = saved("old");
  const farm = new FarmConnection("phone");
  await farm.start();
  storage.remove.mockRejectedValueOnce(new Error("keychain unavailable"));
  await farm.forget();
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", problem: expect.stringContaining("keychain unavailable") });
  expect(storage.text).toBe(saved("old"));
  await farm.forget();
  expect(storage.text).toBeNull();
  expect(farm.snapshot()).toMatchObject({ kind: "pairing", problem: "" });
});

test("cancel restores the durable choice even if a superseded write's rollback failed", async () => {
  storage.text = saved("old");
  const farm = new FarmConnection("phone");
  await farm.start();
  const writing = Promise.withResolvers<void>();
  storage.set
    .mockImplementationOnce(async (_key, text) => {
      await writing.promise;
      storage.text = text;
    })
    .mockRejectedValueOnce(new Error("first restore failed"));
  farm.select(link("a"));
  const pairing = farm.pair();
  reply("a");
  await settle();
  const cancelled = farm.cancel();
  writing.resolve();
  await Promise.all([pairing, cancelled]);
  expect(storage.text).toBe(saved("old"));
  expect(farm.snapshot()).toMatchObject({ kind: "farm", farm: { url: "http://old" } });
});
