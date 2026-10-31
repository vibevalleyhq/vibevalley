// Where memories live: this farm's database, always there and
// first, and a memory service outside it (Nowledge Mem, EverOS), modeled on Hermes's MemoryProvider. Every read asks them
// all at once and takes their answers in turns; a source outside the farm that fails or is slow gives nothing, with a line
// in the log; writes to one go in the background, in order.

import { Cause, Clock, Deferred, Effect, Exit, Fiber, FiberSet, Queue, Schema, Scope } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { messageOf } from "@/errors.ts";
import type { MemorySourceConfig } from "@/setting/memorySources.ts";

import { lineOf, localName, memoryLikeness, pick, recallChars, recallCount, search, type SearchQuery, type SourceSearch, sourceLabel } from "./recall.ts";
import type { FinishedRun, MemoryStore, Note, RecallCue } from "./store";
import { termsOf } from "./terms.ts";

/** One line a source would have the agent recall, with how good a match it is (only to order one source's own). */
export interface RecalledLine {
  readonly id: string;
  readonly line: string;
  readonly score: number;
}

export interface Abilities {
  readonly list: boolean;
  readonly forget: boolean;
  /** It wants whole runs (EverOS), not only the 「记住：」 lines. */
  readonly transcripts: boolean;
}

export interface EndedSession {
  readonly agent: string;
  readonly session: string;
  readonly project: string;
}

/** Why a source did not answer: a service down, a bad answer, stopped. */
export class SourceError extends Schema.TaggedError<SourceError, { readonly brand: unique symbol }>()("SourceError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const sourceError = (e: unknown) => new SourceError({ message: messageOf(e), cause: e });

/** Interrupting one of its operations ends it: a source outside the farm aborts its request. */
export interface Source {
  /** Prefixes the ids of the memories it gives, except the local one's. */
  readonly name: string;
  /** Configured and ready, by config alone: undefined, or why not. */
  readonly unavailable: () => string | undefined;
  /** Lets go of what it holds; an operation that starts after it fails. */
  readonly stop: Effect.Effect<void>;
  /** What the agent should recall as a run starts, best first. */
  readonly prefetch: (cue: RecallCue) => Effect.Effect<RecalledLine[], SourceError>;
  readonly syncTurn: (run: FinishedRun) => Effect.Effect<void, SourceError>;
  readonly sessionEnded: (s: EndedSession) => Effect.Effect<void, SourceError>;
  readonly search: (q: SearchQuery) => Effect.Effect<SourceSearch, SourceError>;
  readonly list: (agent: string) => Effect.Effect<T.Memory[], SourceError>;
  readonly add: (n: Note) => Effect.Effect<T.Memory | undefined, SourceError>;
  readonly forget: (agent: string, id: string) => Effect.Effect<void, SourceError>;
  readonly can: Abilities;
}

/** A source outside the farm's own lifetime: once stopped, an operation going fails (its request interrupted) and one
 * that starts after fails at once. */
export const sourceLife = (name: string) => {
  const stopped = Deferred.makeUnsafe<void>();
  const why = new SourceError({ message: `${name} source has stopped` });
  return {
    stopped: () => Deferred.isDoneUnsafe(stopped),
    alive: <A>(e: Effect.Effect<A, SourceError>): Effect.Effect<A, SourceError> =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(stopped) ? Effect.fail(why) : Effect.raceFirst(e, Effect.andThen(Deferred.await(stopped), Effect.fail(why))),
      ),
    /** True the first time. */
    stop: Deferred.succeed(stopped, undefined),
  };
};

/** How long a source outside the farm may take to answer a read: a run waiting on it is the owner waiting. */
export const prefetchTimeoutMs = 2_000;
/** A write goes in the background, so it may take longer; one that hangs still must not hold the queue for ever. */
const writeTimeoutMs = 30_000;
const writeQueue = 256;

/** The local source: the memory table, picked by recall.ts. Nothing is marked recalled here: the caller marks those it keeps. */
export function localSource(m: MemoryStore, profiles: () => string[]): Source {
  const said = <A, E>(e: Effect.Effect<A, E>) => Effect.mapError(e, sourceError);
  return {
    name: localName,
    unavailable: () => undefined,
    stop: Effect.void,
    prefetch: (cue) =>
      said(
        Effect.gen(function* () {
          let picked: T.Memory[];
          if (cue.peek === true) {
            if (cue.project === "") return [];
            const all = yield* m.list(cue.agent);
            picked = pick(all, { project: cue.project, text: cue.text, now: yield* Clock.currentTimeMillis, matches: yield* m.matches(cue.agent, cue.text) });
          } else picked = yield* m.recallable(cue);
          return picked.map((x, i) => ({ id: x.id, line: lineOf(x, cue.project), score: picked.length - i }));
        }),
      ),
    syncTurn: (r) => said(m.keep(r)),
    sessionEnded: () => Effect.void,
    search: (q) =>
      said(
        Effect.gen(function* () {
          const agents = q.agent === "" ? profiles() : [q.agent];
          const all: T.Memory[] = [];
          const matches: Record<string, number> = {};
          for (const agent of agents) {
            all.push(...(yield* m.list(agent)));
            Object.assign(matches, yield* m.matches(agent, q.text));
          }
          return { found: search(all, q, matches) };
        }),
      ),
    list: (agent) => said(m.listed(agent)),
    add: (n) => said(m.write(n)),
    forget: (agent, id) => said(m.forget(agent, id)),
    can: { list: true, forget: true, transcripts: false },
  };
}

/** The local source's ids go as they are; another's carry its name: name:id. */
const idOf = (one: Source, id: string) => (one.name === localName || id === "" ? id : `${one.name}:${id}`);

/** Which source an id is from, and the id as that source knows it. */
function owner(all: readonly Source[], id: string): [Source, string] {
  const colon = id.indexOf(":");
  if (colon >= 0) {
    const named = all.find((s) => s.name === id.slice(0, colon));
    if (named) return [named, id.slice(colon + 1)];
  }
  return [all[0]!, id];
}

/** The cue as one source gets it: only its own ids to skip, as it knows them. */
function cueFor(one: Source, cue: RecallCue): RecallCue {
  if (!cue.skip || cue.skip.size === 0) return cue;
  const skip = new Set<string>();
  for (const id of cue.skip) {
    const colon = id.indexOf(":");
    if (colon < 0 && one.name === localName) skip.add(id);
    else if (colon >= 0 && id.slice(0, colon) === one.name) skip.add(id.slice(colon + 1));
  }
  return { ...cue, skip };
}

/** Takes the groups best first, one from each in turn (their scores do not compare), leaving out what is nearly one taken. */
export function interleave<T>(groups: readonly (readonly T[])[], text: (item: T) => string, keep: (item: T) => boolean): T[] {
  const out: T[] = [];
  const seen: Set<string>[] = [];
  const texts: string[] = [];
  for (let rank = 0; ; rank++) {
    let more = false;
    for (const g of groups) {
      if (rank >= g.length) continue;
      more = true;
      const one = g[rank]!;
      const terms = termsOf(text(one));
      if (texts.includes(text(one)) || seen.some((item) => memoryLikeness(item, terms) >= 0.8)) continue;
      if (!keep(one)) continue;
      seen.push(terms);
      texts.push(text(one));
      out.push(one);
    }
    if (!more) return out;
  }
}

/** One source's lines go as it gave them; several are taken in turns, the same line once, within the count and characters. */
export function mergeRecalled(groups: readonly (readonly RecalledLine[])[]): RecalledLine[] {
  const some = groups.filter((g) => g.length > 0);
  if (some.length <= 1) return [...(some[0] ?? [])];
  let count = 0;
  let chars = 0;
  return interleave(
    some,
    (l) => l.line,
    (l) => {
      const length = l.line.length + 1;
      if (count === recallCount || chars + length > recallChars) return false;
      count++;
      chars += length;
      return true;
    },
  );
}

/** At most ms on the service's Clock: past it, the operation is interrupted and fails. */
const within = <A>(e: Effect.Effect<A, SourceError>, ms: number) =>
  Effect.timeoutOrElse(e, { duration: ms, orElse: () => Effect.fail(new SourceError({ message: "timed out" })) });

/** The sources as one setting made them. Its scope holds what it does: the operations still going and the writer. */
interface Generation {
  readonly all: Source[];
  readonly off: T.MemorySourceInfo[];
  readonly scope: Scope.Closeable;
  readonly operations: FiberSet.FiberSet;
  /** Background writes, in order, taken by the writer. */
  readonly writes: Queue.Queue<Effect.Effect<void>, Cause.Done>;
  readonly writer: Fiber.Fiber<void>;
  /** Why it was retired, once it is: what an operation it cut short says. */
  why?: string;
  retired?: Fiber.Fiber<void>;
}

/** Owns source generations and every accepted operation, including retirement and shutdown. */
export interface Sources {
  readonly prefetch: (cue: RecallCue) => Effect.Effect<RecalledLine[][]>;
  readonly list: (agent: string) => Effect.Effect<{ memories: T.Memory[]; sources: T.MemorySourceInfo[] }>;
  readonly search: (query: SearchQuery) => Effect.Effect<(SourceSearch & { source: string })[]>;
  /** Why the memory with this id cannot be forgotten here; forget refuses for the same reason. */
  readonly forgetProblem: (id: string) => string | undefined;
  readonly forget: (agent: string, id: string) => Effect.Effect<void, SourceError>;
  readonly add: (note: Note) => void;
  readonly keep: (run: FinishedRun) => void;
  readonly endSession: (session: EndedSession) => void;
  readonly info: () => T.MemorySourceInfo[];
}

export interface SourcesOptions {
  readonly local: Source;
  readonly configured: () => readonly MemorySourceConfig[];
  readonly build: (c: MemorySourceConfig) => Source | undefined;
  readonly timeoutMs?: number;
}

/** Made in the memory service's make: the sources stop with it, the writes still waiting given a moment to go first. */
export const makeSources = (options: SourcesOptions): Effect.Effect<Sources, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { local, configured, build } = options;
    const timeoutMs = options.timeoutMs ?? prefetchTimeoutMs;
    // Generations are made and retired from synchronous calls (the settings changed under info): with the service's
    // services (its logger, its Clock), on its fibers.
    const forkHere = yield* FiberSet.makeRuntime();
    const runHere = Effect.runSyncWith(yield* Effect.context());
    const generations = new Set<Generation>();
    let current: Generation | undefined;
    let built: string | undefined;
    let stopped = false;

    const outside = (g: Generation) => g.all.filter((one) => one !== local);

    const retire = (g: Generation, why: string): Fiber.Fiber<void> =>
      (g.retired ??= forkHere(
        Effect.gen(function* () {
          g.why = why;
          // Interrupts the writer, the writes still waiting, and every operation going.
          yield* Scope.close(g.scope, Exit.void);
          yield* Effect.forEach(
            outside(g),
            (one) =>
              one.stop.pipe(
                Effect.timeoutOption(prefetchTimeoutMs),
                Effect.catchCause((cause) => Effect.logWarning(`stopping memory source ${one.name}: ${Cause.pretty(cause)}`)),
              ),
            { concurrency: "unbounded", discard: true },
          );
          generations.delete(g);
        }),
      ));

    const generation = Effect.fnUntraced(function* (sources: Source[], off: T.MemorySourceInfo[]) {
      const scope = yield* Scope.make();
      const operations = yield* Scope.provide(FiberSet.make(), scope);
      const writes = yield* Queue.dropping<Effect.Effect<void>, Cause.Done>(writeQueue);
      const writer = yield* Effect.forkIn(Effect.ignore(Effect.forever(Effect.flatten(Queue.take(writes)))), scope);
      return { all: sources, off, scope, operations, writes, writer } satisfies Generation;
    });

    const snapshot = (): Generation | undefined => {
      if (stopped) return undefined;
      const now = configured();
      const key = JSON.stringify(now);
      if (key === built) return current;
      if (current) retire(current, "memory sources changed; outside operation canceled");
      const all = [local];
      const off: T.MemorySourceInfo[] = [];
      for (const c of now) {
        const name = c.kind;
        const isOff = (why: string) => off.push({ name, label: sourceLabel(name), on: false, canList: false, canForget: false, transcripts: false, off: why });
        if (c.enabled !== true) {
          isOff(t("server.memory.off"));
          continue;
        }
        const one = build(c);
        if (!one) {
          isOff(t("server.memory.unknownSource"));
          continue;
        }
        const why = one.unavailable();
        if (why) {
          forkHere(Effect.logWarning(`memory from ${name} is off: ${why}`));
          isOff(why);
          continue;
        }
        all.push(one);
      }
      // Made at once: nothing in it waits.
      current = runHere(generation(all, off));
      generations.add(current);
      built = key;
      return current;
    };

    /** An operation of the generation's: retiring it interrupts the operation, which then fails with why. */
    const leased = <A>(g: Generation, operation: Effect.Effect<A, SourceError>): Effect.Effect<A, SourceError> =>
      Effect.flatMap(FiberSet.run(g.operations, operation), (fiber) =>
        Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(new SourceError({ message: g.why ?? "canceled" }))),
        ),
      );

    const logged =
      (line: (why: string) => string) =>
      <A, B>(e: Effect.Effect<A, SourceError>, otherwise: B): Effect.Effect<A | B> =>
        e.pipe(
          Effect.catch((err) => Effect.as(Effect.logWarning(line(err.message)), otherwise)),
          Effect.catchCause((cause) => Effect.as(Effect.logWarning(line(Cause.pretty(cause))), otherwise)),
        );

    const readAll = <T>(g: Generation, what: string, ask: (one: Source) => Effect.Effect<T[], SourceError>, all = g.all) =>
      Effect.forEach(
        all,
        (one) => logged((why) => `memory from ${one.name} for ${what}: ${why}`)(one === local ? ask(one) : leased(g, within(ask(one), timeoutMs)), [] as T[]),
        {
          concurrency: "unbounded",
        },
      );

    const enqueue = (what: string, write: (one: Source) => Effect.Effect<unknown, SourceError>) => {
      const g = snapshot();
      if (!g) return;
      for (const one of g.all.slice(1)) {
        const job = logged((why) => `${what} (${one.name}): ${why}`)(leased(g, within(Effect.asVoid(write(one)), writeTimeoutMs)), undefined);
        if (!Queue.offerUnsafe(g.writes, job)) forkHere(Effect.logWarning(`${what}: too many writes waiting, dropped`));
      }
    };

    const infoOf = (g: Generation): T.MemorySourceInfo[] => [
      ...g.all.map((one) => ({
        name: one.name,
        label: sourceLabel(one.name),
        on: true,
        canList: one.can.list,
        canForget: one.can.forget,
        transcripts: one.can.transcripts,
        off: "",
      })),
      ...g.off,
    ];

    const forgetProblem = (id: string) => {
      const g = snapshot();
      if (!g) return t("server.memory.stopped");
      const [one] = owner(g.all, id);
      return one.can.forget ? undefined : t("server.memory.forgetThere", { source: sourceLabel(one.name) });
    };

    // The writes still waiting go first, for a moment; then every generation is retired and the local source stopped.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopped = true;
        yield* Effect.forEach(
          [...generations],
          Effect.fnUntraced(function* (g) {
            if (!g.retired) {
              yield* Queue.end(g.writes);
              yield* Effect.timeoutOption(Fiber.await(g.writer), prefetchTimeoutMs);
            }
            yield* Fiber.await(retire(g, "memory sources stopped; outside operation canceled"));
          }),
          { concurrency: "unbounded", discard: true },
        );
        yield* local.stop;
      }),
    );

    return {
      prefetch: (cue) =>
        Effect.suspend(() => {
          const g = snapshot();
          return g
            ? readAll(g, cue.agent, (one) => Effect.map(one.prefetch(cueFor(one, cue)), (lines) => lines.map((line) => ({ ...line, id: idOf(one, line.id) }))))
            : Effect.succeed([]);
        }),
      list: (agent) =>
        Effect.suspend(() => {
          const g = snapshot();
          if (!g) return Effect.succeed({ memories: [], sources: [] });
          const listing = g.all.filter((one) => one.can.list);
          return Effect.map(
            readAll(g, `the memories of ${agent}`, (one) => one.list(agent), listing),
            (groups) => ({
              memories: groups.flatMap((listed, i) => {
                const one = listing[i]!;
                return listed.map((m) => ({ ...m, id: idOf(one, m.id), ...(one.name !== localName ? { source: one.name } : {}) }));
              }),
              sources: infoOf(g),
            }),
          );
        }),
      search: (query) =>
        Effect.suspend(() => {
          const g = snapshot();
          if (!g) return Effect.succeed([]);
          return Effect.map(
            readAll(g, "a search", (one) => Effect.map(one.search(query), (page) => [page])),
            (groups) =>
              g.all.map((one, i) => {
                const page = groups[i]?.[0];
                return omitUndefined({
                  source: one.name,
                  found: (page?.found ?? []).map((found) => ({ ...found, id: idOf(one, found.id), source: one.name })),
                  coverage: page ? page.coverage : t("server.memory.coverage.failed"),
                });
              }),
          );
        }),
      forgetProblem,
      forget: (agent, id) =>
        Effect.suspend(() => {
          const problem = forgetProblem(id);
          const g = snapshot();
          if (problem || !g) return Effect.fail(new SourceError({ message: problem ?? t("server.memory.stopped") }));
          const [one, own] = owner(g.all, id);
          return one === local ? one.forget(agent, own) : leased(g, within(one.forget(agent, own), writeTimeoutMs));
        }),
      add: (note) => enqueue(`a note for ${note.agent} did not reach its source`, (one) => one.add(note)),
      keep: (run) => enqueue(`what ${run.session} learned was not kept outside`, (one) => one.syncTurn(run)),
      endSession: (session) => enqueue(`the end of ${session.session} did not reach its source`, (one) => one.sessionEnded(session)),
      info: () => {
        const g = snapshot();
        return g ? infoOf(g) : [];
      },
    } satisfies Sources;
  });
