import { t } from "@vibevalley/i18n";

/** What the device is called on the user's list, until they rename it there: a guess from the browser. */
export function deviceGuess(userAgent: string): string {
  if (/iPhone/u.test(userAgent)) return "iPhone";
  if (/iPad/u.test(userAgent)) return "iPad";
  if (/Android/u.test(userAgent)) return t("web.user.guess.android");
  if (/Macintosh/u.test(userAgent)) return "Mac";
  if (/Windows/u.test(userAgent)) return t("web.user.guess.windows");
  return t("web.user.guess.device");
}
