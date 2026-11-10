import { String as Str } from "effect";

import type { UserStatus } from "@vibevalley/protocol";

/** Where a page opened from outside goes before the farm: nowhere once it holds a key; else signing in (and back to
 * where it was, `at`), or pairing while no password is set to sign in with. */
export function entryFor({ status, at = "/" }: { readonly status: UserStatus | undefined; readonly at?: string }): string {
  if (status?.device !== undefined) return "";
  if (status?.password !== true) return "/pair";
  return at === "/" ? "/login" : "/login?next=" + encodeURIComponent(at);
}

// "//host" and "/\host" are other sites to a browser.
const onThisFarm = (path: string) => Str.startsWith("/")(path) && !Str.startsWith("//")(path) && !Str.startsWith("/\\")(path);

/** Where to go once signed in: the page it was sent away from, only ever a path on this farm. */
export function afterSignIn(search: string): string {
  const next = new URLSearchParams(search).get("next") ?? "/";
  return onThisFarm(next) ? next : "/";
}
