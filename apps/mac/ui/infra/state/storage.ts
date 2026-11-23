import { signal, type Accessor } from "nsh";

export interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PersistentLocalStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
  readonly hydrated: Accessor<boolean>;
  readonly ready: Promise<void>;
  readonly onHydrate: (listener: (key: string, value: string) => void) => () => void;
  readonly flush: () => Promise<void>;
}

/**
 * Synchronous `localStorage`-compatible cache hydrated asynchronously at boot
 * from a persistent KV backend (`nsh`'s `Storage`) with ordered write-through.
 * Falls back gracefully to an in-memory map when `backend` is unavailable or rejects.
 */
export function createPersistentStorage(backend?: StorageBackend): PersistentLocalStorage {
  const cache = new Map<string, string>();
  const dirty = new Set<string>();
  const listeners = new Set<(key: string, value: string) => void>();
  const hydrated = signal(backend === undefined);
  const queued = new Map<string, string | null>();
  let draining: Promise<void> | undefined;

  const ready: Promise<void> =
    backend === undefined
      ? Promise.resolve()
      : (async () => {
          try {
            const keys = await backend.keys();
            const entries = await Promise.all(
              keys.map(async (key): Promise<readonly [string, string | null]> => {
                try {
                  return [key, await backend.getItem(key)] as const;
                } catch {
                  return [key, null] as const;
                }
              }),
            );
            for (const [key, value] of entries) {
              if (value === null || dirty.has(key)) continue;
              const prev = cache.get(key);
              cache.set(key, value);
              if (prev !== value) {
                for (const listener of [...listeners]) listener(key, value);
              }
            }
          } catch {
            // Headless or restricted runs without persistent Storage keep values in memory for the session.
          } finally {
            hydrated.set(true);
          }
        })();

  const drain = (): Promise<void> => {
    if (draining !== undefined) return draining;
    draining = (async () => {
      try {
        while (queued.size > 0) {
          const next = queued.entries().next();
          if (next.done === true) break;
          const [key, value] = next.value;
          queued.delete(key);
          try {
            if (value === null) await backend?.removeItem(key);
            else await backend?.setItem(key, value);
          } catch {
            // Quota or unavailable storage: keep the value in the in-memory session cache.
          }
        }
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  };

  const enqueue = (key: string, value: string | null): void => {
    if (backend === undefined) return;
    queued.set(key, value);
    if (draining === undefined) void drain();
  };

  return {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      dirty.add(key);
      cache.set(key, value);
      enqueue(key, value);
    },
    removeItem: (key) => {
      dirty.add(key);
      cache.delete(key);
      enqueue(key, null);
    },
    hydrated: () => hydrated(),
    ready,
    onHydrate: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush: async () => {
      await ready;
      while (draining !== undefined || queued.size > 0) {
        if (draining !== undefined) await draining;
        else await drain();
      }
    },
  };
}

let activeHydrated: Accessor<boolean> = () => true;

export function setActiveStorageHydrated(accessor: Accessor<boolean>): void {
  activeHydrated = accessor;
}

/** Reactive flag that turns `true` once boot hydration from native `Storage` settles. */
export function isStorageHydrated(): boolean {
  return activeHydrated();
}
