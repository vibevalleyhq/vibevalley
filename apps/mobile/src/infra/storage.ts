import { host, Storage } from "nsh";
import { isAvailable as mobileAvailable } from "nsh/mobile";
import { z } from "zod";

import { jsonString } from "@vibevalley/protocol/schema";

export const PROFILE_STORAGE_KEY = "vibevalley.remote.profile.v1";
export const TOKEN_ACCOUNT_KEY = "vibevalley.remote.bearer-token.v1";
export const TEST_HARNESS_TOKEN_KEY = "vibevalley.remote.token.test-harness.v1";

export const StoredProfileSchema = z.object({
  baseUrl: z.string().min(1),
  deviceName: z.string().min(1),
  serverName: z.string().min(1),
});

export const StoredCredentialsSchema = StoredProfileSchema.extend({
  token: z.string().min(1),
});

const StoredProfileJsonSchema = jsonString(StoredProfileSchema);

export type StoredProfile = z.output<typeof StoredProfileSchema>;
export type StoredCredentials = z.output<typeof StoredCredentialsSchema>;

export type SecureTokenBackend = "native-keychain" | "memory-only" | "test-harness";

export interface SecureTokenStore {
  readonly backend: SecureTokenBackend;
  readonly getToken: (account: string) => Promise<string | undefined>;
  readonly setToken: (account: string, token: string) => Promise<void>;
  readonly deleteToken: (account: string) => Promise<void>;
}

const memoryFallback = new Map<string, string>();
const failedKeys = new Set<string>();
const volatileTokenStore = new Map<string, string>();

async function readStorage(key: string): Promise<string | undefined> {
  if (failedKeys.has(key)) return memoryFallback.get(key);
  try {
    return (await Storage.getItem(key)) ?? undefined;
  } catch {
    return memoryFallback.get(key);
  }
}

async function writeStorage(key: string, value: string): Promise<void> {
  memoryFallback.set(key, value);
  try {
    await Storage.setItem(key, value);
    failedKeys.delete(key);
  } catch {
    failedKeys.add(key);
  }
}

async function removeStorage(key: string): Promise<void> {
  memoryFallback.delete(key);
  try {
    await Storage.removeItem(key);
    failedKeys.delete(key);
  } catch {
    failedKeys.add(key);
  }
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
      const value = await readStorage(TEST_HARNESS_TOKEN_KEY);
      if (value !== undefined && value !== "") return value;
      return volatileTokenStore.get(account);
    },
    setToken: async (account, token) => {
      volatileTokenStore.set(account, token);
      await writeStorage(TEST_HARNESS_TOKEN_KEY, token);
    },
    deleteToken: async (account) => {
      volatileTokenStore.delete(account);
      await removeStorage(TEST_HARNESS_TOKEN_KEY);
    },
  };
}

/**
 * Selects the strongest token store available on the current host:
 * 1. Native Keychain / Android Keystore exposed by the embedding host (`keychain.*`).
 * 2. Volatile memory on mobile builds without a native keychain (never writing plaintext tokens to `Storage`).
 * 3. Isolated test-harness store only on non-mobile headless runs.
 */
export function createSecureTokenStore(): SecureTokenStore {
  const fallback = mobileAvailable ? createMemoryTokenStore() : createTestHarnessTokenStore();
  return host.available() ? createHostKeychainStore(fallback) : fallback;
}

export async function loadCredentials(tokenStore: SecureTokenStore = createSecureTokenStore()): Promise<StoredCredentials | undefined> {
  const rawProfile = await readStorage(PROFILE_STORAGE_KEY);
  if (rawProfile === undefined || rawProfile.trim() === "") return undefined;

  const checkedProfile = StoredProfileJsonSchema.safeParse(rawProfile);
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
  await writeStorage(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export async function clearCredentials(tokenStore: SecureTokenStore = createSecureTokenStore()): Promise<void> {
  await removeStorage(PROFILE_STORAGE_KEY);
  try {
    await tokenStore.deleteToken(TOKEN_ACCOUNT_KEY);
  } catch {
    // Best-effort cleanup when the backing secure store is locked or unavailable.
  }
}
