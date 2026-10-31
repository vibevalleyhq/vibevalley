// A client's request key: the same key again gets the first request's result, and the work is done once. A reply lost on
// the way (the page's retry after a dropped connection) would otherwise create or move a second time.

import { Deferred, Effect, Exit } from "effect";

import { t } from "@vibevalley/i18n";
import type { ApiError } from "@vibevalley/protocol/api";

import { refused } from "@/errors.ts";

/** As long as a chat message's sendKey may be. */
export const requestKeyMax = 64;

/** Keys remembered per op: a retry comes within seconds, so the newest few hundred are plenty. */
const remembered = 500;

/**
 * One op's memo, in memory: a restart forgets every key. Duplicates that come while the first is running wait for it.
 * Only a success is remembered: a refused or failed request changed nothing, so a retry with the same key runs again.
 */
export function requestKeys<A>(): (key: string | undefined, work: Effect.Effect<A, ApiError>) => Effect.Effect<A, ApiError> {
  const seen = new Map<string, Deferred.Deferred<A, ApiError>>();
  return (key, work) => {
    if (key === undefined || key === "") return work;
    if (key.length > requestKeyMax) return Effect.fail(refused(t("server.base.requestKeyLong", { max: requestKeyMax })));
    return Effect.suspend(() => {
      const first = seen.get(key);
      if (first) return Deferred.await(first);
      const mine = Deferred.makeUnsafe<A, ApiError>();
      seen.set(key, mine);
      // Map keeps insertion order: the first key is the oldest.
      if (seen.size > remembered) for (const old of seen.keys()) if (seen.size > remembered) seen.delete(old);
      return work.pipe(
        Effect.onExit((exit) => {
          if (!Exit.isSuccess(exit) && seen.get(key) === mine) seen.delete(key);
          return Deferred.done(mine, exit);
        }),
      );
    });
  };
}
