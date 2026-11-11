import { Cause, Clock, Deferred, Effect, Equal, Exit, Fiber, FiberSet, Queue, Schema, Scope, SynchronizedRef } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { messageOf } from "#/base/errors.ts";
import type { MemorySourceConfig } from "#/modules/setting/memorySources.ts";

import type { FinishedRun, MemoryStore, Note, RecallCue } from "./memory.ts";
import {
  lineOf,
  localName,
  memoryLikeness,
  pick,
  recallChars,
  recallCount,
  search,
  type SearchQuery,
  type SourceSearch,
  sourceLabel,
  termsOf,
} from "./recall.ts";

export interface RecalledLine {
  readonly id: string;
  readonly line: string;
  readonly score: number;
}

interface Abilities {
  readonly list: boolean;
  readonly forget: boolean;
  readonly transcripts: boolean;
}

export interface EndedSession {
  readonly agent: string;
  readonly session: string;
  readonly repo: string;
}

export class SourceError extends Schema.TaggedError<SourceError, { readonly brand: unique symbol }>()("SourceError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const sourceError = (e: unknown) => SourceError.make({ message: messageOf(e), cause: e });

export interface Source {
  readonly name: string;
  readonly unavailable: () => string | undefined;
  readonly stop: Effect.Effect<void>;
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
  const why = SourceError.make({ message: `${name} source has stopped` });
  return {
    stopped: () => Deferred.isDoneUnsafe(stopped),
    alive: <A>(e: Effect.Effect<A, SourceError>): Effect.Effect<A, SourceError> =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(stopped) ? Effect.fail(why) : Effect.raceFirst(e, Effect.andThen(Deferred.await(stopped), Effect.fail(why))),
      ),
    stop: Deferred.succeed(stopped, undefined),
  };
};

export const prefetchTimeoutMs = 2_000;
/** A write goes in the background, so it may take longer; one that hangs still must not hold the queue for ever. */
const writeTimeoutMs = 30_000;
const writeQueue = 256;

/** Does not mark memories recalled; the caller records only lines that fit its prompt budget. */
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
            if (cue.repo === "") return [];
            const all = yield* m.list(cue.agent);
            picked = pick(all, { repo: cue.repo, text: cue.text, now: yield* Clock.currentTimeMillis, matches: yield* m.matches(cue.agent, cue.text) });
          } else picked = yield* m.recallable(cue);
          return picked.map((x, i) => ({ id: x.id, line: lineOf(x, cue.repo), score: picked.length - i }));
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
          yield* Effect.forEach(
            agents,
            (agent) =>
              Effect.gen(function* () {
                all.push(...(yield* m.list(agent)));
                const matches2 = yield* m.matches(agent, q.text);
                Object.assign(matches, matches2);
              }),
            { discard: true },
          );
          return { found: search(all, q, matches) };
        }),
      ),
    list: (agent) => said(m.listed(agent)),
    add: (n) => said(m.write(n)),
    forget: (agent, id) => said(m.forget(agent, id)),
    can: { list: true, forget: true, transcripts: false },
  };
}

const idOf = (one: Source, id: string) => (one.name === localName || id === "" ? id : `${one.name}:${id}`);

function user(all: readonly [Source, ...Source[]], id: string): [Source, string] {
  const colon = id.indexOf(":");
  if (colon >= 0) {
    const named = all.find((s) => s.name === id.slice(0, colon));
    if (named) return [named, id.slice(colon + 1)];
  }
  return [all[0], id];
}

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

/** Round-robin across sources (scores are not comparable across backends), dropping near-duplicates (`>= 0.8` likeness). */
export function interleave<T>(groups: readonly (readonly T[])[], text: (item: T) => string, keep: (item: T) => boolean): T[] {
  const out: T[] = [];
  const seen: Set<string>[] = [];
  const texts: string[] = [];
  for (let rank = 0; ; rank++) {
    let more = false;
    for (const g of groups) {
      const one = g[rank];
      if (one === undefined) continue;
      more = true;
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

const within = <A>(e: Effect.Effect<A, SourceError>, ms: number) =>
  Effect.timeoutOrElse(e, { duration: ms, orElse: () => Effect.fail(SourceError.make({ message: "timed out" })) });

interface Generation {
  readonly all: readonly [Source, ...Source[]];
  readonly off: T.MemorySourceInfo[];
  readonly scope: Scope.Closeable;
  readonly operations: FiberSet.FiberSet;
  readonly writes: Queue.Queue<Effect.Effect<void>, Cause.Done>;
  readonly writer: Fiber.Fiber<void>;
  /** Assigned before `Scope.close` so interrupted fibers observe the retirement reason. */
  retired?: { readonly why: string; readonly done: Deferred.Deferred<void> };
}

type Held =
  | { readonly _tag: "none" }
  | { readonly _tag: "on"; readonly configs: readonly MemorySourceConfig[]; readonly gen: Generation }
  | { readonly _tag: "stopped" };

interface Sources {
  readonly prefetch: (cue: RecallCue) => Effect.Effect<RecalledLine[][]>;
  readonly list: (agent: string) => Effect.Effect<{ memories: T.Memory[]; sources: T.MemorySourceInfo[] }>;
  readonly search: (query: SearchQuery) => Effect.Effect<(SourceSearch & { source: string })[]>;
  readonly forgetProblem: (id: string) => Effect.Effect<string | undefined>;
  readonly forget: (agent: string, id: string) => Effect.Effect<void, SourceError>;
  readonly add: (note: Note) => Effect.Effect<void>;
  readonly keep: (run: FinishedRun) => Effect.Effect<void>;
  readonly endSession: (session: EndedSession) => Effect.Effect<void>;
  readonly info: Effect.Effect<T.MemorySourceInfo[]>;
}

interface SourcesOptions {
  readonly local: Source;
  readonly configured: () => readonly MemorySourceConfig[];
  readonly build: (c: MemorySourceConfig) => Source | undefined;
  readonly timeoutMs?: number;
}

export const makeSources = (options: SourcesOptions): Effect.Effect<Sources, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { local, configured, build } = options;
    const timeoutMs = options.timeoutMs ?? prefetchTimeoutMs;
    const forkHere = yield* FiberSet.makeRuntime();
    const generations = new Set<Generation>();
    const held = yield* SynchronizedRef.make<Held>({ _tag: "none" });

    const outside = (g: Generation) => g.all.filter((one) => one !== local);

    const retire = (g: Generation, why: string): Deferred.Deferred<void> => {
      if (g.retired) return g.retired.done;
      const done = Deferred.makeUnsafe<void>();
      g.retired = { why, done };
      forkHere(
        Effect.gen(function* () {
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
        }).pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
      );
      return done;
    };

    const generation = Effect.fnUntraced(function* (sources: [Source, ...Source[]], off: T.MemorySourceInfo[]) {
      const scope = yield* Scope.make();
      const operations = yield* Scope.provide(FiberSet.make(), scope);
      const writes = yield* Queue.dropping<Effect.Effect<void>, Cause.Done>(writeQueue);
      const writer = yield* Effect.forkIn(Effect.ignore(Effect.forever(Effect.flatten(Queue.take(writes))), { log: "Debug" }), scope);
      return { all: sources, off, scope, operations, writes, writer } satisfies Generation;
    });

    const snapshot: Effect.Effect<Generation | undefined> = SynchronizedRef.modifyEffect(held, (h) =>
      Effect.gen(function* () {
        if (h._tag === "stopped") return [undefined, h] as const;
        const now = configured();
        if (h._tag === "on" && Equal.equals(h.configs, now)) return [h.gen, h] as const;
        if (h._tag === "on") retire(h.gen, "memory sources changed; outside operation canceled");
        const all: [Source, ...Source[]] = [local];
        const off: T.MemorySourceInfo[] = [];
        for (const c of now) {
          const name = c.kind;
          const isOff = (why: string) =>
            off.push({ name, label: sourceLabel(name), on: false, canList: false, canForget: false, transcripts: false, off: why });
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
            yield* Effect.logWarning(`memory from ${name} is off: ${why}`).pipe(Effect.annotateLogs({ source: name }));
            isOff(why);
            continue;
          }
          all.push(one);
        }
        const gen = yield* generation(all, off);
        generations.add(gen);
        return [gen, { _tag: "on", configs: now, gen } satisfies Held] as const;
      }),
    );

    const leased = <A>(g: Generation, operation: Effect.Effect<A, SourceError>): Effect.Effect<A, SourceError> =>
      Effect.flatMap(FiberSet.run(g.operations, operation), (fiber) =>
        Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(SourceError.make({ message: g.retired?.why ?? "canceled" }))),
        ),
      );

    const logged =
      (line: (why: string) => string) =>
      <A, B>(e: Effect.Effect<A, SourceError>, otherwise: B): Effect.Effect<A | B> =>
        e.pipe(
          Effect.catch((err) => Effect.as(Effect.logWarning(line(err.message)), otherwise)),
          Effect.catchCause((cause) => Effect.as(Effect.logWarning(line(Cause.pretty(cause))), otherwise)),
        );

    const readAll = <T>(g: Generation, what: string, ask: (one: Source) => Effect.Effect<T[], SourceError>, all: readonly Source[] = g.all) => {
      const empty: T[] = [];
      return Effect.forEach(
        all,
        (one) => logged((why) => `memory from ${one.name} for ${what}: ${why}`)(one === local ? ask(one) : leased(g, within(ask(one), timeoutMs)), empty),
        {
          concurrency: "unbounded",
        },
      );
    };

    const enqueue = (what: string, write: (one: Source) => Effect.Effect<unknown, SourceError>) =>
      Effect.flatMap(snapshot, (g) =>
        g
          ? Effect.forEach(
              g.all.slice(1),
              (one) => {
                const job = logged((why) => `${what} (${one.name}): ${why}`)(leased(g, within(Effect.asVoid(write(one)), writeTimeoutMs)), undefined);
                return Queue.offer(g.writes, job).pipe(
                  Effect.flatMap((taken) => (taken ? Effect.void : Effect.logWarning(`${what}: too many writes waiting, dropped`))),
                  Effect.annotateLogs({ source: one.name }),
                );
              },
              { discard: true },
            )
          : Effect.void,
      );

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

    const forgetProblem = (id: string) =>
      Effect.map(snapshot, (g): string | undefined => {
        if (!g) return t("server.memory.stopped");
        const [one] = user(g.all, id);
        return one.can.forget ? undefined : t("server.memory.forgetThere", { source: sourceLabel(one.name) });
      });

    // Drain pending background writes briefly before retiring active generations.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* SynchronizedRef.set(held, { _tag: "stopped" });
        yield* Effect.forEach(
          [...generations],
          Effect.fnUntraced(function* (g) {
            if (!g.retired) {
              yield* Queue.end(g.writes);
              yield* Effect.timeoutOption(Fiber.await(g.writer), prefetchTimeoutMs);
            }
            yield* Deferred.await(retire(g, "memory sources stopped; outside operation canceled"));
          }),
          { concurrency: "unbounded", discard: true },
        );
        yield* local.stop;
      }),
    );

    return {
      prefetch: (cue) =>
        Effect.flatMap(snapshot, (g) =>
          g
            ? readAll(g, cue.agent, (one) => Effect.map(one.prefetch(cueFor(one, cue)), (lines) => lines.map((line) => ({ ...line, id: idOf(one, line.id) }))))
            : Effect.succeed([]),
        ),
      list: (agent) =>
        Effect.flatMap(snapshot, (g) => {
          if (!g) return Effect.succeed({ memories: [], sources: [] });
          const listing = g.all.filter((one) => one.can.list);
          return Effect.map(
            readAll(g, `the memories of ${agent}`, (one) => one.list(agent), listing),
            (groups) => ({
              memories: groups.flatMap((listed, i) => {
                const one = listing[i];
                return one ? listed.map((m) => ({ ...m, id: idOf(one, m.id), ...(one.name !== localName ? { source: one.name } : {}) })) : [];
              }),
              sources: infoOf(g),
            }),
          );
        }),
      search: (query) =>
        Effect.flatMap(snapshot, (g) => {
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
        Effect.gen(function* () {
          const problem = yield* forgetProblem(id);
          const g = yield* snapshot;
          if (problem || !g) return yield* SourceError.make({ message: problem ?? t("server.memory.stopped") });
          const [one, own] = user(g.all, id);
          return yield* one === local ? one.forget(agent, own) : leased(g, within(one.forget(agent, own), writeTimeoutMs));
        }),
      add: (note) => enqueue(`a note for ${note.agent} did not reach its source`, (one) => one.add(note)),
      keep: (run) => enqueue(`what ${run.session} learned was not kept outside`, (one) => one.syncTurn(run)),
      endSession: (session) => enqueue(`the end of ${session.session} did not reach its source`, (one) => one.sessionEnded(session)),
      info: Effect.map(snapshot, (g) => (g ? infoOf(g) : [])),
    } satisfies Sources;
  });
