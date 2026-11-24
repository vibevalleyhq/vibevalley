import { expect, test } from "nsh/test";

import { createCoalescedStorage, type AsyncStorageBackend } from "./storage";

test("createCoalescedStorage coalesces rapid setItem calls on the same key while a write is in flight", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const disk = new Map<string, string>();
  const setCalls: [string, string][] = [];

  const backend: AsyncStorageBackend = {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => {
      setCalls.push([key, value]);
      if (setCalls.length === 1) await firstWriteGate;
      disk.set(key, value);
    },
    removeItem: async (key) => {
      disk.delete(key);
    },
  };

  const store = createCoalescedStorage(backend);
  const writes: Promise<void>[] = [];
  for (let i = 1; i <= 25; i++) {
    writes.push(store.setItem("profile", `v${i}`));
  }

  expect(setCalls).toEqual([["profile", "v1"]]);
  expect(await store.getItem("profile")).toBe("v25");

  releaseFirst?.();
  await Promise.all(writes);
  await store.flush();

  expect(setCalls).toEqual([
    ["profile", "v1"],
    ["profile", "v25"],
  ]);
  expect(disk.get("profile")).toBe("v25");
  expect(await store.getItem("profile")).toBe("v25");
});

test("createCoalescedStorage preserves setItem followed by removeItem ordering while in flight", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const disk = new Map<string, string>();
  const ops: string[] = [];

  const backend: AsyncStorageBackend = {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => {
      ops.push(`set:${key}=${value}`);
      if (ops.length === 1) await firstWriteGate;
      disk.set(key, value);
    },
    removeItem: async (key) => {
      ops.push(`remove:${key}`);
      disk.delete(key);
    },
  };

  const store = createCoalescedStorage(backend);
  const p1 = store.setItem("profile", "v1");
  const p2 = store.setItem("profile", "v2");
  const p3 = store.removeItem("profile");

  expect(await store.getItem("profile")).toBeUndefined();

  releaseFirst?.();
  await Promise.all([p1, p2, p3]);
  await store.flush();

  expect(ops).toEqual(["set:profile=v1", "remove:profile"]);
  expect(disk.has("profile")).toBe(false);
  expect(await store.getItem("profile")).toBeUndefined();
});

test("createCoalescedStorage keeps memory fallback when backend writes reject", async () => {
  const backend: AsyncStorageBackend = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error("storage unavailable");
    },
    removeItem: async () => {
      throw new Error("storage unavailable");
    },
  };

  const store = createCoalescedStorage(backend);
  await store.setItem("profile", "cached");
  expect(await store.getItem("profile")).toBe("cached");

  await store.removeItem("profile");
  expect(await store.getItem("profile")).toBeUndefined();
});
