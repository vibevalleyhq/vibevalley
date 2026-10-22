// The farm this phone is paired with, kept in the system's keychain (expo-secure-store): its address, the key the farm
// gave this phone, and the computer's name. Pairing questions the farm's lan listener (lan.pair) and waits for the owner.

import * as SecureStore from "expo-secure-store";
import type { LanPaired } from "@vibevalley/protocol";
import type { PairLink } from "./rules";

export interface Farm {
  readonly url: string;
  readonly key: string;
  readonly hostName: string;
}

const where = "vibevalley.farm";

export async function savedFarm(): Promise<Farm | undefined> {
  const text = await SecureStore.getItemAsync(where).catch(() => null);
  if (!text) return undefined;
  try {
    const f = JSON.parse(text) as Farm;
    return f.url && f.key ? f : undefined;
  } catch {
    return undefined;
  }
}

export const forgetFarm = () => SecureStore.deleteItemAsync(where).catch(() => undefined);

/** Waits while the owner decides (up to two minutes); a refusal is said as the farm said it. */
export async function pair(link: PairLink, name: string): Promise<Farm> {
  let res: Response;
  try {
    res = await fetch(link.url + "/api/v1/lan/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: link.code, name }),
    });
  } catch {
    throw new Error("连不上那台电脑：两台设备要在同一个网络里，那台电脑要允许连接");
  }
  const text = await res.text();
  if (!res.ok) {
    let reason = text;
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason ?? text;
    } catch {
      // Not the farm's refusal: its text as it is.
    }
    throw new Error(reason || `那台电脑答了 ${res.status}`);
  }
  const paired = JSON.parse(text) as LanPaired;
  const farm = { url: link.url, key: paired.key, hostName: paired.hostName };
  await SecureStore.setItemAsync(where, JSON.stringify(farm));
  return farm;
}
