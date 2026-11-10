import { deviceKeyCookie } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The page came through the lan listener, not from this computer's own server. */
export const isRemote = (hostname: string) => !loopback.has(hostname);

/** The cookie to keep a paired key in, for ten years; only this origin's own requests carry it. */
export const keyCookie = (key: string) => `${deviceKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Strict`;

/** Pairs this device and keeps its key. */
export async function pair(code: string, name: string) {
  const paired = await api.lan.pair({ code, name });
  document.cookie = keyCookie(paired.key);
}
