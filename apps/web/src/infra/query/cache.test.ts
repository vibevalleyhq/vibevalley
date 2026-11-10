import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { waitForReads } from "./activity";
import { createQueryClient, defineQuery } from "./cache";

const deferred = <T>() => {
  let finish: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (!finish) throw new Error("Promise not initialized");
      finish(value);
    },
  };
};

const clients: ReturnType<typeof createQueryClient>[] = [];
const client = () => {
  const c = createQueryClient();
  clients.push(c);
  return c;
};
const flush = () => vi.advanceTimersByTimeAsync(0);
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  vi.useRealTimers();
});

test("regression: startup errors include only enabled consumers and clear after confirmed data", async () => {
  const c = client();
  const query = defineQuery({
    schema: Schema.Finite,
    key: () => ["startup"],
    fetch: (): Promise<number> => Promise.reject(new Error("unavailable")),
  });
  await expect(c.fetch(query())).rejects.toThrow("unavailable");
  expect(c.hasActiveErrors()).toBe(false);
  const watcher = c.subscribe(query(), () => undefined, { enabled: true, interval: false });
  await expect(c.fetch(query())).rejects.toThrow("unavailable");
  expect(c.hasActiveErrors()).toBe(true);
  watcher.update({ enabled: false, interval: false });
  expect(c.hasActiveErrors()).toBe(false);
  watcher.update({ enabled: true, interval: false });
  await expect(c.fetch(query())).rejects.toThrow("unavailable");
  expect(c.hasActiveErrors()).toBe(true);
  c.setData(query(), () => ({ value: 1 }));
  expect(c.hasActiveErrors()).toBe(false);
  watcher.stop();
});

test("deduplicates leases and isolates clients and typed key segments", async () => {
  const work = deferred<string>();
  const fetch = vi.fn(() => work.promise);
  const query = defineQuery({ schema: Schema.String, key: (id: string | number) => ["one", id], fetch, staleTime: Infinity });
  const a = client();
  const b = client();
  const first = a.fetch(query("1"));
  const second = a.fetch(query("1"));
  const third = b.fetch(query("1"));
  work.resolve("ok");
  await Promise.all([first, second, third]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(a.read(query(1)).record).toBeUndefined();
  expect(await a.fetch(query("1"))).toBe("ok");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("regression: invalidation during a read waits for a new answer without overlap", async () => {
  vi.useFakeTimers();
  const first = deferred<number>();
  const second = deferred<number>();
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const query = defineQuery({ schema: Schema.Finite, key: () => ["one"], fetch: (): Promise<number> => fetch() });
  const c = client();
  const got = c.fetch(query());
  await flush();
  const refreshed = c.invalidate();
  await c.invalidate({ prefix: ["other"] });
  first.resolve(1);
  await flush();
  expect(c.read(query()).record).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  second.resolve(2);
  expect(await got).toBe(2);
  expect((await refreshed)[0]?.status).toBe("fulfilled");
});

test("regression: confirmed data and clear cannot be overwritten by ignored cancellation", async () => {
  vi.useFakeTimers();
  const work = deferred<number>();
  const query = defineQuery({ schema: Schema.Finite, key: () => ["one"], fetch: () => work.promise });
  const c = client();
  const promise = c.fetch(query()).catch((e: unknown) => e);
  await flush();
  c.setData(query(), () => ({ value: 2 }));
  work.resolve(1);
  await promise;
  expect(c.read(query()).record?.value).toBe(2);
  expect(c.fetching()).toBe(0);
  const next = deferred<number>();
  const another = defineQuery({ schema: Schema.Finite, key: () => ["two"], fetch: () => next.promise });
  const pending = c.fetch(another()).catch((e: unknown) => e);
  await flush();
  c.clear();
  next.resolve(4);
  await pending;
  expect(c.read(another()).record).toBeUndefined();
});

test("refresh errors keep the successful record, including undefined", async () => {
  let fail = false;
  const query = defineQuery({
    schema: Schema.Undefined,
    key: () => ["one"],
    fetch: (): Promise<undefined> => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(undefined)),
    staleTime: Infinity,
  });
  const c = client();
  await c.fetch(query());
  expect(c.read(query()).status).toBe("success");
  expect(c.read(query()).record).toBeDefined();
  fail = true;
  await expect(c.fetch(query(), true)).rejects.toThrow("offline");
  expect(c.read(query()).status).toBe("error");
  expect(c.read(query()).record).toBeDefined();
  c.setData(query(), () => undefined);
  expect(c.read(query()).status).toBe("error");
  c.setData(query(), () => ({ value: undefined }));
  expect(c.read(query()).status).toBe("success");
});

test("shared subscribers and explicit leases cancel only after the last demand ends", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const work = deferred<number>();
  const query = defineQuery({
    schema: Schema.Finite,
    key: () => ["one"],
    fetch: (_: void, context) => {
      signal = context.signal;
      return work.promise;
    },
  });
  const c = client();
  const one = c.subscribe(query(), () => {}, { enabled: true, interval: false });
  const two = c.subscribe(query(), () => {}, { enabled: true, interval: false });
  await flush();
  one.stop();
  expect(signal?.aborted).toBe(false);
  const lease = c.fetch(query());
  two.stop();
  expect(signal?.aborted).toBe(false);
  work.resolve(3);
  expect(await lease).toBe(3);
  expect(c.fetching()).toBe(0);
});

test("last disabled subscriber aborts and prevents late writes", async () => {
  vi.useFakeTimers();
  const work = deferred<number>();
  let signal: AbortSignal | undefined;
  const query = defineQuery({
    schema: Schema.Finite,
    key: () => ["one"],
    fetch: (_: void, ctx) => {
      signal = ctx.signal;
      return work.promise;
    },
  });
  const c = client();
  const sub = c.subscribe(query(), () => {}, { enabled: true, interval: false });
  await flush();
  sub.update({ enabled: false, interval: false });
  expect(signal?.aborted).toBe(true);
  work.resolve(8);
  await flush();
  expect(c.read(query()).record).toBeUndefined();
  sub.stop();
});

test("polls at the shortest demand, marks stale on time, and stops timers on GC", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.resolve(1));
  const query = defineQuery({ schema: Schema.Finite, key: () => ["one"], fetch, staleTime: 10, gcTime: 5 });
  const c = client();
  const changed = vi.fn();
  const sub = c.subscribe(query(), changed, { enabled: true, interval: 50 });
  await flush();
  expect(c.read(query()).stale).toBe(false);
  changed.mockClear();
  await vi.advanceTimersByTimeAsync(10);
  expect(changed).toHaveBeenCalled();
  expect(c.read(query()).stale).toBe(true);
  const fast = c.subscribe(query(), () => {}, { enabled: true, interval: 20 });
  await flush();
  const count = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20);
  expect(fetch).toHaveBeenCalledTimes(count + 1);
  fast.stop();
  sub.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(c.read(query()).record).toBeUndefined();
});

test("bounded classified retries are canceled with their user", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.reject(new Error("retry")));
  const query = defineQuery({ schema: Schema.Finite, key: () => ["one"], fetch, retry: 1, retryWhen: () => true });
  const c = client();
  const outcome = c.fetch(query()).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(251);
  expect(await outcome).toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledTimes(2);
  const sub = c.subscribe(query(), () => {}, { enabled: true, interval: false });
  await flush();
  sub.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("regression: repeated callback identities retain separate demands and disposal does not notify a closed client", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const work = deferred<number>();
  const query = defineQuery({
    schema: Schema.Finite,
    key: () => ["dispose"],
    fetch: (_: void, context) => {
      signal = context.signal;
      return work.promise;
    },
  });
  const c = client();
  const changed = vi.fn(() => c.read(query()));
  const one = c.subscribe(query(), changed, { enabled: true, interval: false });
  const two = c.subscribe(query(), changed, { enabled: true, interval: false });
  await flush();
  one.stop();
  expect(signal?.aborted).toBe(false);
  changed.mockClear();
  expect(() => c.dispose()).not.toThrow();
  expect(signal?.aborted).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  expect(() => two.stop()).not.toThrow();
  work.resolve(9);
  await flush();
  expect(c.fetching()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("key prefixes use segments and conflicting definitions fail", async () => {
  const a = defineQuery({ schema: Schema.Finite, key: (id: string) => [id], fetch: () => Promise.resolve(1), staleTime: Infinity });
  const b = defineQuery({ schema: Schema.Finite, key: () => ["a"], fetch: () => Promise.resolve(2) });
  const c = client();
  await c.fetch(a("a"));
  await c.fetch(a("ab"));
  await c.invalidate({ prefix: ["a"] });
  expect(c.read(a("a")).stale).toBe(true);
  expect(c.read(a("ab")).stale).toBe(false);
  expect(() => c.read(b())).toThrow("Conflicting");
  expect(() => a(Number.NaN.toString())).not.toThrow();
  const invalid = defineQuery({ schema: Schema.Finite, key: () => [Number.NaN], fetch: () => Promise.resolve(1) });
  expect(invalid).toThrow("finite");
});

test("regression: startup timeout releases query activity subscriptions", async () => {
  let subscribed = 0;
  const c = {
    fetching: () => 1,
    subscribeActivity: () => {
      subscribed++;
      return () => {
        subscribed--;
      };
    },
  };
  const abort = new AbortController();
  const pending = waitForReads(c, abort.signal);
  expect(subscribed).toBe(1);
  abort.abort();
  await pending;
  expect(subscribed).toBe(0);
});
