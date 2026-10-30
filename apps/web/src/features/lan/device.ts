// The page opened from another device, through the farm's lan listener (连接到本机): it pairs once on /pair and keeps
// its key in a cookie the listener reads (lanKeyCookie); on the farm's own computer it needs none.

import { t } from "@vibevalley/i18n";
import { lanKeyCookie } from "@vibevalley/protocol";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The page came through the lan listener, not from this computer's own server. */
export const isRemote = (hostname: string) => !loopback.has(hostname);

/** document.cookie holds a key. */
export const isPaired = (cookie: string) => cookie.split(";").some((c) => c.trim().startsWith(lanKeyCookie + "=") && c.trim().length > lanKeyCookie.length + 1);

/** The cookie to keep a paired key in, for ten years; only this origin's own requests carry it. */
export const keyCookie = (key: string) => `${lanKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Strict`;

/** What the device is called on the owner's list, until they rename it there: a guess from the browser. */
export function deviceGuess(userAgent: string): string {
  if (/iPhone/u.test(userAgent)) return "iPhone";
  if (/iPad/u.test(userAgent)) return "iPad";
  if (/Android/u.test(userAgent)) return t("web.lan.devices.android");
  if (/Macintosh/u.test(userAgent)) return "Mac";
  if (/Windows/u.test(userAgent)) return t("web.lan.devices.windows");
  return t("web.lan.devices.device");
}
