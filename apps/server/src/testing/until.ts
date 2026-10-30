// Waiting in a test for what the farm does: the core state's transitions here; the rest is @vibevalley/testkit's.

import { Effect, Option, Stream } from "effect";

import type { WorkspaceState } from "@vibevalley/protocol";

import { Core } from "@/core/core.ts";

export { aTurn, gate, nextTurn, until, untilGot, waitFor, whenTrue, within } from "@vibevalley/testkit/until";

/** What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. It
 * waits on the core's transitions, not by asking again; the deadline is real time, as for waitFor. */
export const whenState = <A>(pick: (state: WorkspaceState) => A | undefined | false, what: string | (() => string), ms = 5_000) =>
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* Core;
      const [now, changes] = yield* core.transitions;
      const first = pick(now);
      if (first !== undefined && first !== false) return first;
      const found = Stream.runHead(
        Stream.filter(
          Stream.map(changes, (t) => pick(t.after)),
          (a): a is A => a !== undefined && a !== false,
        ),
      );
      const late = Effect.as(
        Effect.promise(() => new Promise<void>((r) => setTimeout(r, ms))),
        Option.none<A>(),
      );
      const got = yield* Effect.raceFirst(found, late);
      if (Option.isNone(got)) return yield* Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`));
      return got.value;
    }),
  );
