import { t } from "@vibevalley/i18n";
// What the phone works out with no device in the way: where a pairing link points, what to call this phone, how the
// page is told its key. The rest of the shell (App.tsx and its pieces) only wires these to the native modules.

import { lanKeyCookie } from "@vibevalley/protocol";

/** A pairing: the farm's address on the network (scheme, host and port) and the one-time code. */
export interface PairLink {
  readonly url: string;
  readonly code: string;
}

/** The QR code's link (http://<address>:<port>/pair?c=<code>), or the app's own (vibevalley://pair?u=<address>&c=<code>),
 * which a link opened elsewhere hands to the app; anything else is undefined. */
export function parsePairLink(text: string): PairLink | undefined {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return undefined;
  }
  const code = (u.searchParams.get("c") ?? "").trim();
  if (!code) return undefined;
  if (u.protocol === "vibevalley:") {
    const farm = parseFarm(u.searchParams.get("u") ?? "");
    return farm && (u.host === "pair" || u.pathname.replace(/^\/+/u, "") === "pair") ? { url: farm, code } : undefined;
  }
  if ((u.protocol === "http:" || u.protocol === "https:") && u.pathname === "/pair") return { url: u.origin, code };
  return undefined;
}

/** The address alone, http(s) only. */
function parseFarm(text: string): string | undefined {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** What the owner's list calls this phone until they rename it there. */
export function deviceName(os: string, model: string | undefined): string {
  if (model) return model;
  return os === "ios" ? "iPhone" : os === "android" ? t("mobile.android") : t("mobile.phone");
}

/** The script that puts the key where the page's requests carry it, before the page runs: the cookie the farm's lan
 * listener reads (lan.ts), as a paired browser keeps it. */
export const keyScript = (key: string) =>
  `document.cookie = ${JSON.stringify(`${lanKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Strict`)}; true;`;

/** The page's own pairing route: the farm no longer knows this phone's key. */
export const isPairPage = (farm: string, url: string) => {
  try {
    const u = new URL(url);
    return u.origin === farm && u.pathname === "/pair";
  } catch {
    return false;
  }
};

/** A volume from Agora's 0..255 as the page's 0..100. */
export const level = (volume: number | undefined) => Math.round(((volume ?? 0) * 100) / 255);
