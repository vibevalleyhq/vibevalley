// The game: the ledger the farm's progress folds from, the commits that make its level, and the
// plot the owner planted for the next helper. Entries the farm's facts tell of are recorded watching them (entriesFor);
// what the owner does that is no fact (a review, a call, a title) where it happens. The ledger never stops the farm: an
// entry that cannot be written is logged, and the farm goes on.

import { Clock, Context, Effect, Layer, Predicate, Schedule, Schema, Semaphore, Stream, Option } from "effect";

import type { Achievement, CommitCount, LedgerEntry } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { Core } from "@/core/core.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { Project } from "@/project/project.ts";

import * as q from "../../db/generated/game_ledger.sql.ts";
import { achievementsInWords, catchUp, entriesFor, type Entry, type Folded, progressFold, progressStep } from "./progress.ts";

/** The person plants on an empty plot and then says what to do; the orchestrator hires a session for it some seconds later. */
const wantStationForMs = 10_000;
const countEveryMs = 2 * 60_000;
const countAfterRunMs = 15_000;

/** A ledger row's payload, and the entry it makes with the row's kind and time; a row this code cannot read any more is none. */
const payloadOf = jsonOrNone(Schema.Unknown);
const entryOf = Schema.decodeUnknownOption(S.LedgerEntry);

export class Game extends Context.Service<
  Game,
  {
    /** The achievements in words, in the page's order; how far the farm is with each goes in every frame's view. */
    readonly achievements: () => Achievement[];
    /** The title the owner wears: an achievement and its tier; none of either is the plain title. */
    readonly chooseTitle: (achievement: string | undefined, tier: number | undefined) => Effect.Effect<void>;
    /** The next session hired within ten seconds goes to this station, if it is still free. */
    readonly want: (station: number) => void;
    readonly record: (entry: Entry) => Effect.Effect<void>;
    /** Commits on every project, a repository with several worktrees once: "yours" by author email. */
    readonly count: () => Effect.Effect<CommitCount>;
    /** The count and its write, serialized with run-end refreshes. */
    readonly refresh: Effect.Effect<void>;
    /** How many runs' ends asked for a count. */
    readonly asked: () => number;
  }
>()("vibevalley/Game") {
  static readonly layer = Layer.effect(
    Game,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const config = yield* ServerConfig;
  const core = yield* Core;
  const projects = yield* Project;
  const db = yield* Db;

  // A row this code cannot read any more is left out of the fold.
  const rows = yield* db.run(q.ledgerEntries());
  const entries: LedgerEntry[] = [];
  for (const row of rows) {
    const fields = payloadOf(row.payload);
    if (!Predicate.isObject(fields)) continue;
    const entry = entryOf({ ...fields, kind: row.kind, at: row.at });
    if (Option.isSome(entry)) entries.push(entry.value);
  }
  let folded: Folded = progressFold(entries);
  yield* core.apply({ type: "progress", progress: folded.progress });

  // One entry at a time, so the order in the table is the order of the fold.
  const one = yield* Semaphore.make(1);
  const record = Effect.fn("Game.record")(
    function* (input: Entry) {
      const at = yield* Clock.currentTimeMillis;
      const entry = { ...input, at };
      const { kind, at: _, ...payload } = entry;
      yield* db.attempt(q.addLedgerEntry({ id: newId(at), kind, at, payload: JSON.stringify(payload) }));
      const [next, news] = progressStep(folded, entry);
      folded = next;
      yield* core.apply({ type: "progress", progress: next.progress, ...((news.coins ?? 0) !== 0 || news.unlocked.length > 0 ? { news } : {}) });
    },
    (effect, input) => Effect.catchCause(effect, (cause) => Effect.logError(`vibevalley: a ledger entry (${input.kind}) was not kept`, cause)),
    one.withPermits(1),
  );

  const extra = config.gitEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  const count = Effect.fn("Game.count")(function* (): Effect.fn.Return<CommitCount> {
    const repos = yield* projects.contributions(extra);
    return { repos, total: repos.reduce((n, r) => n + r.commits, 0) };
  });
  // The ticker and a run's end both count: one at a time, so an older count never lands after a newer one.
  const counting = yield* Semaphore.make(1);
  const refresh = counting.withPermits(1)(Effect.flatMap(count(), core.setCommits));
  let asked = 0;
  let pending = false;
  const scope = yield* Effect.scope;
  // Several runs share one count.
  const soon = Effect.gen(function* () {
    asked++;
    if (pending) return;
    pending = true;
    yield* Effect.forkIn(
      Effect.sleep(countAfterRunMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            pending = false;
          }),
        ),
        Effect.andThen(refresh),
      ),
      scope,
    );
  });

  let wanted: { station: number; until: number } | undefined;

  const [state, transitions] = yield* core.transitions;
  for (const e of catchUp(state)) yield* record(e);
  yield* Effect.forkScoped(
    Stream.runForEach(transitions, ({ before, fact, after }) =>
      Effect.gen(function* () {
        if (fact.type === "progress") return;
        if (fact.type === "report") yield* soon;
        if (fact.type === "hired") {
          const wish = wanted;
          wanted = undefined;
          if (wish && wish.until > fact.at) yield* core.apply({ type: "station", id: fact.session.id, station: wish.station });
        }
        for (const e of entriesFor(before, fact, after)) yield* record(e);
      }),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(yield* core.owner, (d) => (d.kind === "reviewed" ? record({ kind: "reviewed", session: d.session }) : record({ kind: "voice" }))),
  );

  return Game.of({
    achievements: achievementsInWords,
    chooseTitle: Effect.fn("Game.chooseTitle")(function* (achievement, tier) {
      return yield* record({ kind: "titled", ...(achievement ? { achievement } : {}), ...(tier != null && tier !== 0 ? { tier } : {}) });
    }),
    want: (station) => {
      wanted = { station, until: clock.currentTimeMillisUnsafe() + wantStationForMs };
    },
    record,
    count,
    refresh,
    asked: () => asked,
  });
});

/** The commits counted now and every two minutes, once the farm is up. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const game = yield* Game;
    yield* Effect.forkScoped(game.refresh.pipe(Effect.repeat(Schedule.spaced(countEveryMs))));
  }),
);
