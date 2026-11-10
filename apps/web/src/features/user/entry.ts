import type { UserStatus } from "@vibevalley/protocol";

/** Where a page opened from outside goes before the farm: nowhere once it holds a key; else signing in, or pairing
 * while no password is set to sign in with. */
export function entryFor(status: UserStatus | undefined): "" | "/login" | "/pair" {
  if (status?.device !== undefined) return "";
  return status?.password === true ? "/login" : "/pair";
}
