// A whole farm for the flow tests, which go through several services at once (an issue refined, sent, completed; a
// memory kept by one session and recalled by the next). No binary, login or model: the helpers are oar's scripted
// runtime over real git repositories in temporary folders, doing what the words of their brief say (testing/helper.ts).

import { type Runtime } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { Effect, Stream } from "effect";

import type * as T from "@vibevalley/protocol";

import { Core } from "@/core/core.ts";
import type { ServerConfig } from "@/infra/config.ts";
import { agentSessionsStart, gamification, inboxStart, taskGraphsStart } from "@/services.ts";
import { type Hired } from "@/session/session.ts";
import { gitIn } from "@/testing/git.ts";
import { helper } from "@/testing/helper.ts";
import { starter, testConfig } from "@/testing/layers.ts";
import { until as untilHeld, waitFor } from "@/testing/until.ts";
import { world, type WorldOptions } from "@/testing/world.ts";

/** The seed profile on pi, with no effort: the scripted runtime has no models, so no effort levels. */
export const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });

const farmLayer = (options: WorldOptions) => world(options).pipe(gamification, agentSessionsStart, taskGraphsStart, inboxStart);

export interface Farm {
  readonly config: ServerConfig["Service"];
  readonly turns: ScriptedTurn[];
  readonly layer: ReturnType<typeof farmLayer>;
}

/** The farm with its one runtime, pi: testing/helper.ts's unless the test gives its own. As the server starts it, sessions
 * left on the farm by the last run come back (Agent Sessions' startup), and the game keeps its ledger. */

export function farm(
  options: Omit<WorldOptions, "runtimes"> & {
    readonly change?: (c: ServerConfig["Service"]) => ServerConfig["Service"];
    readonly runtime?: Runtime;
  } = {},
): Farm {
  const base = options.config ?? testConfig();
  const config = options.change ? options.change(base) : base;
  const turns: ScriptedTurn[] = [];
  return {
    config,
    turns,
    layer: farmLayer({ ...options, config, runtimes: [options.runtime ?? helper(turns)] }),
  };
}

/** Every fact and notice from now on, kept as they come. */
export const watch = Effect.gen(function* () {
  const core = yield* Core;
  const facts: T.Fact[] = [];
  const notes: string[] = [];
  const events = yield* core.subscribe;
  yield* Effect.forkScoped(
    Stream.runForEach(events, (e) =>
      Effect.sync(() => {
        if (e.type === "notice") notes.push(e.text);
        else if (e.type !== "snapshot" && e.type !== "event" && e.type !== "runtime") facts.push(e);
      }),
    ),
  );
  let taken = 0;
  /** The next report not cut off by a stop, in order. */
  const nextReport = until(
    () => facts.filter((f): f is T.FactReport => f.type === "report" && f.outcome !== "interrupted").length > taken,
    "the next report",
  ).pipe(Effect.map(() => facts.filter((f): f is T.FactReport => f.type === "report" && f.outcome !== "interrupted")[taken++]!));
  return { facts, notes, nextReport };
});

/** Polls until ok, or fails the test after ten seconds. */
export const until = (ok: () => boolean | Promise<boolean>, what: string) => untilHeld(ok, what, 10_000);

/** The value got once ok says so. */
export const await_ = <A, E>(get: () => Effect.Effect<A, E> | A, ok: (a: A) => boolean, what: string) =>
  waitFor(
    Effect.suspend(() => {
      const got = get();
      return Effect.isEffect(got) ? Effect.orDie(got) : Effect.succeed(got);
    }),
    ok,
    what,
    10_000,
  );

export const mustHire = (h: Hired): T.Session => {
  if (!h.session) throw new Error("refused: " + h.refused);
  return h.session;
};

export const git = gitIn;
