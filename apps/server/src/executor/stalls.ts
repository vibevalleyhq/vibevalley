import type { Session as RuntimeSession } from "@botiverse/oar";
import { initialStatus, reduceStatus, stallOf } from "@botiverse/oar/observe";
import { Effect } from "effect";

/** Calls onStall once a turn has had no record for stallMs, folded from the session's first record as its events are:
 * oar's observeStalls hears only records from when it subscribes, and misses a turn that went quiet before that. */
export function watchStalls(
  session: RuntimeSession,
  stallMs: number,
  onStall: (silentForMs: number, at: number) => void,
  timer: (wait: Effect.Effect<void>) => void,
  now: () => number,
) {
  let status = initialStatus;
  // The timer is one keyed fiber of the service's: arming again replaces it, Effect.void disarms it.
  const disarm = () => timer(Effect.void);
  const stop = session.rawEvents(
    (record) => {
      status = reduceStatus(status, record, session.id);
      if (status.kind !== "running") return disarm();
      timer(
        Effect.sleep(stallMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const at = now();
              const stall = stallOf(status, at, stallMs);
              if (stall !== null) onStall(stall.silentForMs, at);
            }),
          ),
        ),
      );
    },
    { sessionId: session.id, afterSeq: -1 },
  );
  return () => {
    disarm();
    stop();
  };
}
