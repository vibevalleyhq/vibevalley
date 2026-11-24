import "../polyfill";
import { expect, test } from "nsh/test";

import { createPersistentStorage, type StorageBackend } from "./storage";

function memoryBackend(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const backend: StorageBackend = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    keys: async () => [...data.keys()],
  };
  return { data, backend };
}

test("regression: createPersistentStorage hydrates from KV, writes through setItem/removeItem, and survives reload", async () => {
  const kv = memoryBackend({ "vibevalley.prefs": JSON.stringify({ theme: "dark", scale: 110 }) });

  const session1 = createPersistentStorage(kv.backend);
  const hydratedEvents: [string, string][] = [];
  session1.onHydrate((key, value) => hydratedEvents.push([key, value]));
  expect(session1.hydrated()).toBe(false);

  await session1.ready;
  expect(session1.hydrated()).toBe(true);
  expect(session1.getItem("vibevalley.prefs")).toBe(JSON.stringify({ theme: "dark", scale: 110 }));
  expect(hydratedEvents).toEqual([["vibevalley.prefs", JSON.stringify({ theme: "dark", scale: 110 })]]);

  session1.setItem("vibevalley.prefs", JSON.stringify({ theme: "light", scale: 125 }));
  session1.setItem("vibevalley.temp", "drop-me");
  session1.removeItem("vibevalley.temp");
  await session1.flush();

  expect(kv.data.get("vibevalley.prefs")).toBe(JSON.stringify({ theme: "light", scale: 125 }));
  expect(kv.data.has("vibevalley.temp")).toBe(false);

  const session2 = createPersistentStorage(kv.backend);
  await session2.ready;
  expect(session2.getItem("vibevalley.prefs")).toBe(JSON.stringify({ theme: "light", scale: 125 }));
  expect(session2.getItem("vibevalley.temp")).toBeNull();
});

test("regression: local write before hydration settles is not clobbered by stale KV values", async () => {
  let releaseKeys: (() => void) | undefined;
  const keysGate = new Promise<void>((resolve) => {
    releaseKeys = resolve;
  });
  const kv = memoryBackend({ "vibevalley.prefs": JSON.stringify({ theme: "light" }) });
  const slowBackend: StorageBackend = {
    ...kv.backend,
    keys: async () => {
      await keysGate;
      return kv.backend.keys();
    },
  };

  const store = createPersistentStorage(slowBackend);
  const hydratedEvents: [string, string][] = [];
  store.onHydrate((key, value) => hydratedEvents.push([key, value]));

  store.setItem("vibevalley.prefs", JSON.stringify({ theme: "dark" }));
  releaseKeys?.();
  await store.flush();

  expect(store.getItem("vibevalley.prefs")).toBe(JSON.stringify({ theme: "dark" }));
  expect(kv.data.get("vibevalley.prefs")).toBe(JSON.stringify({ theme: "dark" }));
  expect(hydratedEvents).toEqual([]);
});

test("regression: persistent storage falls back to in-memory cache when native Storage rejects", async () => {
  const broken: StorageBackend = {
    getItem: () => Promise.reject(new Error("storage unavailable")),
    setItem: () => Promise.reject(new Error("quota exceeded")),
    removeItem: () => Promise.reject(new Error("storage unavailable")),
    keys: () => Promise.reject(new Error("storage unavailable")),
  };

  const store = createPersistentStorage(broken);
  await store.ready;
  expect(store.hydrated()).toBe(true);

  store.setItem("vibevalley.prefs", JSON.stringify({ theme: "dark" }));
  await store.flush();
  expect(store.getItem("vibevalley.prefs")).toBe(JSON.stringify({ theme: "dark" }));

  store.removeItem("vibevalley.prefs");
  await store.flush();
  expect(store.getItem("vibevalley.prefs")).toBeNull();
});

test("regression: rapid setItem calls on the same key coalesce while a write is in flight", async () => {
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const data = new Map<string, string>();
  const setCalls: [string, string][] = [];
  const backend: StorageBackend = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      setCalls.push([key, value]);
      if (setCalls.length === 1) await firstWriteGate;
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    keys: async () => [...data.keys()],
  };

  const store = createPersistentStorage(backend);
  await store.ready;

  for (let i = 1; i <= 50; i++) {
    store.setItem("k", `v${i}`);
  }
  expect(store.getItem("k")).toBe("v50");
  expect(setCalls.length).toBe(1);

  releaseFirstWrite?.();
  await store.flush();

  expect(setCalls.length).toBeLessThanOrEqual(2);
  expect(setCalls.at(-1)).toEqual(["k", "v50"]);
  expect(data.get("k")).toBe("v50");
});

test("regression: setItem followed by removeItem on the same key while in flight persists removal", async () => {
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const data = new Map<string, string>();
  const ops: string[] = [];
  const backend: StorageBackend = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      ops.push(`set:${key}=${value}`);
      if (ops.length === 1) await firstWriteGate;
      data.set(key, value);
    },
    removeItem: async (key) => {
      ops.push(`remove:${key}`);
      data.delete(key);
    },
    keys: async () => [...data.keys()],
  };

  const store = createPersistentStorage(backend);
  await store.ready;

  store.setItem("k", "v1");
  store.setItem("k", "v2");
  store.removeItem("k");
  expect(store.getItem("k")).toBeNull();

  releaseFirstWrite?.();
  await store.flush();

  expect(ops).toEqual(["set:k=v1", "remove:k"]);
  expect(data.has("k")).toBe(false);
  expect(store.getItem("k")).toBeNull();
});
