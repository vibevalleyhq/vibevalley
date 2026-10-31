import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { createRegistry } from "./atom";
import { orFallback, storedAtom } from "./stored";

afterEach(() => vi.unstubAllGlobals());

/** A Storage over a Map; `broken` throws on every call, as a sandboxed frame's or a full one's does. */
function memoryStorage(start: Record<string, string> = {}, broken = false) {
  const items = new Map(Object.entries(start));
  const check = () => {
    if (broken) throw new Error("storage is off");
  };
  return {
    items,
    getItem: (k: string) => (check(), items.get(k) ?? null),
    setItem: (k: string, v: string) => (check(), void items.set(k, v)),
    removeItem: (k: string) => (check(), void items.delete(k)),
    clear: () => (check(), items.clear()),
    key: () => null,
    get length() {
      return items.size;
    },
  };
}

class StorageEvent extends Event {
  readonly key: string;
  readonly newValue: string;
  constructor(key: string, newValue: string) {
    super("storage");
    this.key = key;
    this.newValue = newValue;
  }
}

const Look = Schema.Struct({ view: orFallback(Schema.Literals(["board", "list"]), "board"), dense: orFallback(Schema.Boolean, false) });
const fallback = { view: "board" as const, dense: false };

test("a choice is read under the page's namespace, and a set is written there", () => {
  const storage = memoryStorage({ "vibevalley.look": JSON.stringify({ view: "list", dense: true }) });
  vi.stubGlobal("localStorage", storage);
  const registry = createRegistry();
  const look = storedAtom("look", Look, fallback);
  const off = registry.subscribe(look, () => {}, { immediate: true });
  expect(registry.get(look)).toEqual({ view: "list", dense: true });
  registry.set(look, { view: "board", dense: true });
  expect(JSON.parse(storage.items.get("vibevalley.look") ?? "")).toEqual({ view: "board", dense: true });
  off();
});

test("what does not decode reads as the fallback, a field at a time where the schema says so", () => {
  vi.stubGlobal("localStorage", memoryStorage({ "vibevalley.look": JSON.stringify({ view: "grid", dense: true }), "vibevalley.count": "not json" }));
  const registry = createRegistry();
  const look = storedAtom("look", Look, fallback);
  const count = storedAtom("count", Schema.Finite, 7);
  expect(registry.get(look)).toEqual({ view: "board", dense: true });
  expect(registry.get(count)).toBe(7);
});

test("a storage that throws leaves the choice for the page's life", () => {
  vi.stubGlobal("localStorage", memoryStorage({}, true));
  const registry = createRegistry();
  const count = storedAtom("count", Schema.Finite, 1);
  const off = registry.subscribe(count, () => {}, { immediate: true });
  expect(registry.get(count)).toBe(1);
  registry.set(count, 2);
  expect(registry.get(count)).toBe(2);
  off();
});

test("no storage at all reads the fallback", () => {
  vi.stubGlobal("localStorage", undefined);
  const registry = createRegistry();
  expect(registry.get(storedAtom("count", Schema.Finite, 3))).toBe(3);
});

test("every reader hears a set, and a write from another tab", () => {
  vi.stubGlobal("localStorage", memoryStorage());
  const tab = new EventTarget();
  vi.stubGlobal("window", tab);
  const registry = createRegistry();
  const count = storedAtom("count", Schema.Finite, 0);
  const first = vi.fn();
  const second = vi.fn();
  const offFirst = registry.subscribe(count, first, { immediate: true });
  const offSecond = registry.subscribe(count, second, { immediate: true });
  registry.set(count, 5);
  expect(first).toHaveBeenLastCalledWith(5);
  expect(second).toHaveBeenLastCalledWith(5);
  tab.dispatchEvent(new StorageEvent("vibevalley.count", "9"));
  expect(registry.get(count)).toBe(9);
  expect(first).toHaveBeenLastCalledWith(9);
  tab.dispatchEvent(new StorageEvent("vibevalley.other", "1"));
  tab.dispatchEvent(new StorageEvent("vibevalley.count", "nonsense"));
  expect(registry.get(count)).toBe(9);
  offFirst();
  offSecond();
});
