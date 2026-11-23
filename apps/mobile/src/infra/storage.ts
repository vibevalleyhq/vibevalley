import { Storage } from "nsh";
import { z } from "zod";

const CREDENTIALS_KEY = "vibevalley.remote.credentials.v1";

export const StoredCredentialsSchema = z.object({
  baseUrl: z.string().min(1),
  token: z.string().min(1),
  deviceName: z.string().min(1),
  serverName: z.string().min(1),
});

export type StoredCredentials = z.output<typeof StoredCredentialsSchema>;

const fallbackStore = new Map<string, string>();

async function readRaw(key: string): Promise<string | undefined> {
  try {
    const value = await Storage.getItem(key);
    return value ?? undefined;
  } catch {
    return fallbackStore.get(key);
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  fallbackStore.set(key, value);
  try {
    await Storage.setItem(key, value);
  } catch {
    // Headless or restricted runs without storage keep credentials in memory for the session.
  }
}

async function deleteRaw(key: string): Promise<void> {
  fallbackStore.delete(key);
  try {
    await Storage.removeItem(key);
  } catch {
    // Headless or restricted runs without storage have nothing persisted to clear.
  }
}

export async function loadCredentials(): Promise<StoredCredentials | undefined> {
  const raw = await readRaw(CREDENTIALS_KEY);
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    await deleteRaw(CREDENTIALS_KEY);
    return undefined;
  }
  const checked = StoredCredentialsSchema.safeParse(parsedJson);
  if (!checked.success) {
    await deleteRaw(CREDENTIALS_KEY);
    return undefined;
  }
  return checked.data;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  const checked = StoredCredentialsSchema.parse(credentials);
  await writeRaw(CREDENTIALS_KEY, JSON.stringify(checked));
}

export async function clearCredentials(): Promise<void> {
  await deleteRaw(CREDENTIALS_KEY);
}
