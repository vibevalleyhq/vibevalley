import { host, nativeModule, Storage } from "nsh";
import { isAvailable as mobileAvailable } from "nsh/mobile";
import { z } from "zod";

export const PROFILE_STORAGE_KEY = "vibevalley.remote.profile.v1";
export const TOKEN_ACCOUNT_KEY = "vibevalley.remote.bearer-token.v1";
export const TEST_HARNESS_TOKEN_KEY = "vibevalley.remote.token.test-harness.v1";
const NATIVE_KEYCHAIN_MODULE = "vibevalley/keychain";

export const StoredProfileSchema = z.object({
  baseUrl: z.string().min(1),
  deviceName: z.string().min(1),
  serverName: z.string().min(1),
});

export const StoredCredentialsSchema = StoredProfileSchema.extend({
  token: z.string().min(1),
});

export type StoredProfile = z.output<typeof StoredProfileSchema>;
export type StoredCredentials = z.output<typeof StoredCredentialsSchema>;

export type SecureTokenBackend = "native-keychain" | "memory-only" | "test-harness";

export interface SecureTokenStore {
  readonly backend: SecureTokenBackend;
  readonly getToken: (account: string) => Promise<string | undefined>;
  readonly setToken: (account: string, token: string) => Promise<void>;
  readonly deleteToken: (account: string) => Promise<void>;
}

interface NativeKeychainContract {
  readonly getItem?: (key: string) => Promise<string | null> | string | null;
  readonly setItem?: (key: string, value: string) => Promise<void> | void;
  readonly removeItem?: (key: string) => Promise<void> | void;
  readonly get?: (key: string) => Promise<string | null> | string | null;
  readonly set?: (key: string, value: string) => Promise<void> | void;
  readonly delete?: (key: string) => Promise<void> | void;
}

export interface AsyncStorageBackend {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}

export interface CoalescedStorage {
  readonly getItem: (key: string) => Promise<string | undefined>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly flush: () => Promise<void>;
}

const nshStorageBackend: AsyncStorageBackend = {
  getItem: (key) => Storage.getItem(key),
  setItem: (key, value) => Storage.setItem(key, value),
  removeItem: (key) => Storage.removeItem(key),
};

/**
 * Per-key write-through coalescing queue over an async Storage backend: rapid writes or deletions
 * on the same key collapse to the latest state while keeping memory reads synchronous-fresh.
 */
export function createCoalescedStorage(backend: AsyncStorageBackend = nshStorageBackend): CoalescedStorage {
  const memoryCache = new Map<string, string>();
  const queued = new Map<string, string | null>();
  const activeLoops = new Map<string, Promise<void>>();
  const lastWriteFailed = new Set<string>();

  const enqueue = (key: string, op: string | null): Promise<void> => {
    if (op === null) memoryCache.delete(key);
    else memoryCache.set(key, op);
    queued.set(key, op);

    const existing = activeLoops.get(key);
    if (existing !== undefined) return existing;

    const loop = (async () => {
      try {
        while (queued.has(key)) {
          const next = queued.get(key);
          queued.delete(key);
          if (next === undefined) continue;
          try {
            if (next === null) await backend.removeItem(key);
            else await backend.setItem(key, next);
            lastWriteFailed.delete(key);
          } catch {
            // Headless or restricted runs without storage keep metadata in memory for the session.
            lastWriteFailed.add(key);
          }
        }
      } finally {
        activeLoops.delete(key);
      }
    })();

    activeLoops.set(key, loop);
    return loop;
  };

  return {
    getItem: async (key) => {
      if (activeLoops.has(key) || lastWriteFailed.has(key)) {
        return memoryCache.get(key);
      }
      try {
        const value = await backend.getItem(key);
        return value ?? undefined;
      } catch {
        return memoryCache.get(key);
      }
    },
    setItem: (key, value) => enqueue(key, value),
    removeItem: (key) => enqueue(key, null),
    flush: async () => {
      while (activeLoops.size > 0 || queued.size > 0) {
        await Promise.all([...activeLoops.values()]);
      }
    },
  };
}

const defaultStorage = createCoalescedStorage();
const volatileTokenStore = new Map<string, string>();

async function readProfileRaw(key: string): Promise<string | undefined> {
  return defaultStorage.getItem(key);
}

async function writeProfileRaw(key: string, value: string): Promise<void> {
  await defaultStorage.setItem(key, value);
}

async function deleteProfileRaw(key: string): Promise<void> {
  await defaultStorage.removeItem(key);
}

const HostErrorCodeSchema = z.object({ code: z.string() });

function isUnavailableHostError(err: unknown): boolean {
  const parsed = HostErrorCodeSchema.safeParse(err);
  if (!parsed.success) return false;
  const { code } = parsed.data;
  return code === "ERR_NSH_HOST_ERROR" || code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" || code === "ERR_ACCESS_DENIED";
}

function createHostKeychainStore(fallback: SecureTokenStore): SecureTokenStore {
  return {
    backend: "native-keychain",
    getToken: async (account) => {
      try {
        const value = await host.call<string | null>("keychain.get", { account });
        return typeof value === "string" && value !== "" ? value : undefined;
      } catch (err: unknown) {
        if (isUnavailableHostError(err)) return fallback.getToken(account);
        throw err;
      }
    },
    setToken: async (account, token) => {
      try {
        await host.call("keychain.set", { account, token });
      } catch (err: unknown) {
        if (isUnavailableHostError(err)) {
          await fallback.setToken(account, token);
          return;
        }
        throw err;
      }
    },
    deleteToken: async (account) => {
      try {
        await host.call("keychain.delete", { account });
      } catch (err: unknown) {
        if (isUnavailableHostError(err)) {
          await fallback.deleteToken(account);
          return;
        }
        throw err;
      }
    },
  };
}

function resolveNativeKeychain(): SecureTokenStore | undefined {
  let mod: NativeKeychainContract;
  try {
    mod = nativeModule<NativeKeychainContract>(NATIVE_KEYCHAIN_MODULE);
  } catch {
    return undefined;
  }

  const readFn = typeof mod.getItem === "function" ? mod.getItem : typeof mod.get === "function" ? mod.get : undefined;
  const writeFn = typeof mod.setItem === "function" ? mod.setItem : typeof mod.set === "function" ? mod.set : undefined;
  const deleteFn = typeof mod.removeItem === "function" ? mod.removeItem : typeof mod.delete === "function" ? mod.delete : undefined;
  if (!readFn || !writeFn || !deleteFn) return undefined;

  return {
    backend: "native-keychain",
    getToken: async (account) => {
      const value = await readFn(account);
      return typeof value === "string" && value !== "" ? value : undefined;
    },
    setToken: async (account, token) => {
      await writeFn(account, token);
    },
    deleteToken: async (account) => {
      await deleteFn(account);
    },
  };
}

function createMemoryTokenStore(): SecureTokenStore {
  return {
    backend: "memory-only",
    getToken: (account) => Promise.resolve(volatileTokenStore.get(account)),
    setToken: (account, token) => {
      volatileTokenStore.set(account, token);
      return Promise.resolve();
    },
    deleteToken: (account) => {
      volatileTokenStore.delete(account);
      return Promise.resolve();
    },
  };
}

function createTestHarnessTokenStore(): SecureTokenStore {
  return {
    backend: "test-harness",
    getToken: async (account) => {
      const value = await defaultStorage.getItem(TEST_HARNESS_TOKEN_KEY);
      if (value !== undefined && value !== "") return value;
      return volatileTokenStore.get(account);
    },
    setToken: async (account, token) => {
      volatileTokenStore.set(account, token);
      await defaultStorage.setItem(TEST_HARNESS_TOKEN_KEY, token);
    },
    deleteToken: async (account) => {
      volatileTokenStore.delete(account);
      await defaultStorage.removeItem(TEST_HARNESS_TOKEN_KEY);
    },
  };
}

/**
 * Selects the strongest token store available on the current host:
 * 1. Native Keychain / Android Keystore exposed by the embedding host (`keychain.*`) or native UI module.
 * 2. Volatile memory on mobile builds without a native keychain (never writing plaintext tokens to `Storage`).
 * 3. Isolated test-harness store only on non-mobile headless runs.
 */
export function createSecureTokenStore(): SecureTokenStore {
  const fallback = mobileAvailable ? createMemoryTokenStore() : createTestHarnessTokenStore();
  if (host.available()) return createHostKeychainStore(fallback);
  const nativeStore = resolveNativeKeychain();
  if (nativeStore) return nativeStore;
  return fallback;
}

export async function loadCredentials(tokenStore: SecureTokenStore = createSecureTokenStore()): Promise<StoredCredentials | undefined> {
  const rawProfile = await readProfileRaw(PROFILE_STORAGE_KEY);
  if (rawProfile === undefined || rawProfile.trim() === "") return undefined;

  let parsedProfileJson: unknown;
  try {
    parsedProfileJson = JSON.parse(rawProfile);
  } catch {
    await clearCredentials(tokenStore);
    return undefined;
  }

  const checkedProfile = StoredProfileSchema.safeParse(parsedProfileJson);
  if (!checkedProfile.success) {
    await clearCredentials(tokenStore);
    return undefined;
  }

  let token: string | undefined;
  try {
    token = await tokenStore.getToken(TOKEN_ACCOUNT_KEY);
  } catch {
    return undefined;
  }

  const checked = StoredCredentialsSchema.safeParse({
    ...checkedProfile.data,
    token,
  });
  if (!checked.success) {
    await clearCredentials(tokenStore);
    return undefined;
  }
  return checked.data;
}

export async function saveCredentials(credentials: StoredCredentials, tokenStore: SecureTokenStore = createSecureTokenStore()): Promise<void> {
  const checked = StoredCredentialsSchema.parse(credentials);
  const profile: StoredProfile = {
    baseUrl: checked.baseUrl,
    deviceName: checked.deviceName,
    serverName: checked.serverName,
  };
  await tokenStore.setToken(TOKEN_ACCOUNT_KEY, checked.token);
  await writeProfileRaw(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export async function clearCredentials(tokenStore: SecureTokenStore = createSecureTokenStore()): Promise<void> {
  await deleteProfileRaw(PROFILE_STORAGE_KEY);
  try {
    await tokenStore.deleteToken(TOKEN_ACCOUNT_KEY);
  } catch {
    // Best-effort cleanup when the backing secure store is locked or unavailable.
  }
}
