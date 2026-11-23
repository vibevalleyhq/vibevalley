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
  let pending: Promise<void> = Promise.resolve();

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

  const enqueue = (task: () => Promise<void>): void => {
    if (backend === undefined) return;
    pending = pending.then(async () => {
      try {
        await task();
      } catch {
        // Quota or unavailable storage: keep the value in the in-memory session cache.
      }
    });
  };

  return {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      dirty.add(key);
      cache.set(key, value);
      enqueue(() => backend?.setItem(key, value) ?? Promise.resolve());
    },
    removeItem: (key) => {
      dirty.add(key);
      cache.delete(key);
      enqueue(() => backend?.removeItem(key) ?? Promise.resolve());
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
      await pending;
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
