import { abortable, anySignal, type Clock, isAbort, Queue, systemClock, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { messageOf } from "#/base/errors.ts";
import type { Logger } from "#/infra/log.ts";
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

export class SourceError extends Error {
  override readonly name = "SourceError";
}

export const sourceError = (e: unknown) => (e instanceof SourceError ? e : new SourceError(messageOf(e), { cause: e }));

/** What a source outside the farm needs: the farm's fetch (aborting a call's signal aborts its request), its clock and log. */
export interface SourceDeps {
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly log: Logger;
}

/** A memory source. Every call takes a signal: aborting it cuts the call short (its request aborted). A failure is a
 * SourceError. */
export interface Source {
  readonly name: string;
  readonly unavailable: () => string | undefined;
  readonly stop: () => Promise<void>;
  readonly prefetch: (cue: RecallCue, signal: AbortSignal) => Promise<RecalledLine[]>;
  readonly syncTurn: (run: FinishedRun, signal: AbortSignal) => Promise<void>;
  readonly sessionEnded: (s: EndedSession, signal: AbortSignal) => Promise<void>;
  readonly search: (q: SearchQuery, signal: AbortSignal) => Promise<SourceSearch>;
  readonly list: (agent: string, signal: AbortSignal) => Promise<T.Memory[]>;
  readonly add: (n: Note, signal: AbortSignal) => Promise<T.Memory | undefined>;
  readonly forget: (agent: string, id: string, signal: AbortSignal) => Promise<void>;
  readonly can: Abilities;
}

/** A source outside the farm's own lifetime: once stopped, an operation going fails (its request aborted) and one that
 * starts after fails at once. */
export const sourceLife = (name: string) => {
  const stopped = new AbortController();
  const why = () => new SourceError(`${name} source has stopped`);
  return {
    stopped: () => stopped.signal.aborted,
    alive: async <A>(f: (signal: AbortSignal) => Promise<A>, signal?: AbortSignal): Promise<A> => {
      if (stopped.signal.aborted) throw why();
      const both = anySignal(stopped.signal, signal);
      try {
        return await abortable(f(both), both);
      } catch (e) {
        if (stopped.signal.aborted) throw why();
        throw e;
      }
    },
    /** True for the call that stopped it, false once it was stopped already. */
    stop: (): boolean => {
      if (stopped.signal.aborted) return false;
      stopped.abort(why());
      return true;
    },
  };
};

export const prefetchTimeoutMs = 2_000;
/** A write goes in the background, so it may take longer; one that hangs still must not hold the queue for ever. */
const writeTimeoutMs = 30_000;
const writeQueue = 256;

/** Does not mark memories recalled; the caller records only lines that fit its prompt budget. */
export function localSource(m: MemoryStore, profiles: () => string[], clock: Clock): Source {
  const said = async <A>(p: () => Promise<A>): Promise<A> => {
    try {
      return await p();
    } catch (e) {
      throw sourceError(e);
    }
  };
  return {
    name: localName,
    unavailable: () => undefined,
    stop: async () => {},
    prefetch: (cue) =>
      said(async () => {
        let picked: T.Memory[];
        if (cue.peek === true) {
          if (cue.repo === "") return [];
          const all = await m.list(cue.agent);
          picked = pick(all, { repo: cue.repo, text: cue.text, now: clock.now(), matches: await m.matches(cue.agent, cue.text) });
        } else picked = await m.recallable(cue);
        return picked.map((x, i) => ({ id: x.id, line: lineOf(x, cue.repo), score: picked.length - i }));
      }),
    syncTurn: (r) => said(() => m.keep(r)),
    sessionEnded: async () => {},
    search: (q) =>
      said(async () => {
        const agents = q.agent === "" ? profiles() : [q.agent];
        const all: T.Memory[] = [];
        const matches: Record<string, number> = {};
        for (const agent of agents) {
          all.push(...(await m.list(agent)));
          Object.assign(matches, await m.matches(agent, q.text));
        }
        return { found: search(all, q, matches) };
      }),
    list: (agent) => said(() => m.listed(agent)),
    add: (n) => said(() => m.write(n)),
    forget: (agent, id) => said(() => m.forget(agent, id)),
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

/** f with a deadline: one that takes longer is cut short and fails as timed out. */
const within = async <A>(f: (signal: AbortSignal) => Promise<A>, ms: number, clock: Clock, signal: AbortSignal): Promise<A> => {
  try {
    return await withTimeout(f, ms, { clock, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError" && !signal.aborted) throw new SourceError("timed out");
    throw e;
  }
};

interface Generation {
  readonly all: readonly [Source, ...Source[]];
  readonly off: T.MemorySourceInfo[];
  /** Aborted (with a SourceError saying why) when the generation is retired: its operations and its writer stop. */
  readonly ops: AbortController;
  readonly writes: Queue<() => Promise<void>>;
  /** The writer: settles once it has ended, never rejects. */
  readonly writer: Promise<void>;
  /** Assigned before ops aborts, so a cut-short operation reads the retirement reason. */
  retired?: { readonly why: string; readonly done: Promise<void> };
}

type Held =
  | { readonly _tag: "none" }
  | { readonly _tag: "on"; readonly configs: readonly MemorySourceConfig[]; readonly gen: Generation }
  | { readonly _tag: "stopped" };

export interface Sources {
  readonly prefetch: (cue: RecallCue) => Promise<RecalledLine[][]>;
  readonly list: (agent: string) => Promise<{ memories: T.Memory[]; sources: T.MemorySourceInfo[] }>;
  readonly search: (query: SearchQuery) => Promise<(SourceSearch & { source: string })[]>;
  readonly forgetProblem: (id: string) => Promise<string | undefined>;
  /** Fails with SourceError. */
  readonly forget: (agent: string, id: string) => Promise<void>;
  readonly add: (note: Note) => Promise<void>;
  readonly keep: (run: FinishedRun) => Promise<void>;
  readonly endSession: (session: EndedSession) => Promise<void>;
  readonly info: () => Promise<T.MemorySourceInfo[]>;
  /** Drains pending background writes briefly, then retires every generation and stops the local source. */
  readonly close: () => Promise<void>;
}

export interface SourcesOptions {
  readonly local: Source;
  readonly configured: () => readonly MemorySourceConfig[];
  readonly build: (c: MemorySourceConfig) => Source | undefined;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  readonly log: Logger;
}

/** Two lists of configured sources are the same when every field is, the key by its value. */
const sameConfigs = (a: readonly MemorySourceConfig[], b: readonly MemorySourceConfig[]) => {
  const plain = (cs: readonly MemorySourceConfig[]) => JSON.stringify(cs.map(({ key, ...rest }) => [rest, key?.reveal() ?? null]));
  return a === b || plain(a) === plain(b);
};

export function makeSources(options: SourcesOptions): Sources {
  const { local, configured, build, log } = options;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? prefetchTimeoutMs;
  const generations = new Set<Generation>();
  let held: Held = { _tag: "none" };

  const outside = (g: Generation) => g.all.filter((one) => one !== local);

  const retire = (g: Generation, why: string): Promise<void> => {
    if (g.retired) return g.retired.done;
    const { promise: done, resolve } = Promise.withResolvers<void>();
    g.retired = { why, done };
    g.ops.abort(new SourceError(why));
    // The writes still waiting go with it.
    g.writes.takeAll();
    g.writes.end();
    const stopping = async () => {
      await g.writer;
      await Promise.all(
        outside(g).map(async (one) => {
          try {
            await withTimeout(() => one.stop(), prefetchTimeoutMs, { clock });
          } catch (e) {
            // One that does not stop in time is left to stop on its own.
            if (!isAbort(e)) log.warn(`stopping memory source ${one.name}: ${messageOf(e)}`);
          }
        }),
      );
      generations.delete(g);
    };
    stopping().then(resolve, (e: unknown) => {
      log.error("retiring memory sources", e);
      resolve();
    });
    return done;
  };

  const generation = (sources: [Source, ...Source[]], off: T.MemorySourceInfo[]): Generation => {
    const ops = new AbortController();
    const writes = new Queue<() => Promise<void>>({ capacity: writeQueue, overflow: "dropping" });
    const writer = (async () => {
      for (;;) {
        let next: IteratorResult<() => Promise<void>>;
        try {
          next = await writes.next(ops.signal);
        } catch (e) {
          // Retired: the writes still waiting are dropped with it.
          log.debug("memory writes stopped", e);
          return;
        }
        if (next.done === true || ops.signal.aborted) return;
        await next.value();
      }
    })();
    return { all: sources, off, ops, writes, writer };
  };

  const snapshot = (): Generation | undefined => {
    const h = held;
    if (h._tag === "stopped") return undefined;
    const now = configured();
    if (h._tag === "on" && sameConfigs(h.configs, now)) return h.gen;
    if (h._tag === "on") void retire(h.gen, "memory sources changed; outside operation canceled");
    const all: [Source, ...Source[]] = [local];
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
        log.warn(`memory from ${name} is off: ${why}`);
        isOff(why);
        continue;
      }
      all.push(one);
    }
    const gen = generation(all, off);
    generations.add(gen);
    held = { _tag: "on", configs: now, gen };
    return gen;
  };

  const leased = async <A>(g: Generation, operation: (signal: AbortSignal) => Promise<A>): Promise<A> => {
    const signal = g.ops.signal;
    try {
      return await abortable(operation(signal), signal);
    } catch (e) {
      if (signal.aborted) throw new SourceError(g.retired?.why ?? "canceled");
      throw e;
    }
  };

  const logged =
    (line: (why: string) => string) =>
    async <A, B>(p: () => Promise<A>, otherwise: B): Promise<A | B> => {
      try {
        return await p();
      } catch (e) {
        log.warn(line(messageOf(e)));
        return otherwise;
      }
    };

  const readAll = <A>(g: Generation, what: string, ask: (one: Source, signal: AbortSignal) => Promise<A[]>, all: readonly Source[] = g.all) => {
    const empty: A[] = [];
    // The farm's own rows are not cut short: only the sources outside it are leased and timed.
    const never = new AbortController().signal;
    return Promise.all(
      all.map((one) =>
        logged((why) => `memory from ${one.name} for ${what}: ${why}`)(
          () => (one === local ? ask(one, never) : leased(g, (signal) => within((s) => ask(one, s), timeoutMs, clock, signal))),
          empty,
        ),
      ),
    );
  };

  const enqueue = async (what: string, write: (one: Source, signal: AbortSignal) => Promise<unknown>) => {
    const g = snapshot();
    if (!g) return;
    for (const one of g.all.slice(1)) {
      const job = async () => {
        await logged((why) => `${what} (${one.name}): ${why}`)(
          () =>
            leased(g, (signal) =>
              within(
                async (s) => {
                  await write(one, s);
                },
                writeTimeoutMs,
                clock,
                signal,
              ),
            ),
          undefined,
        );
      };
      if (!g.writes.offer(job)) log.warn(`${what}: too many writes waiting, dropped`);
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

  const forgetProblem = (id: string): string | undefined => {
    const g = snapshot();
    if (!g) return t("server.memory.stopped");
    const [one] = user(g.all, id);
    return one.can.forget ? undefined : t("server.memory.forgetThere", { source: sourceLabel(one.name) });
  };

  const close = async () => {
    held = { _tag: "stopped" };
    await Promise.all(
      [...generations].map(async (g) => {
        if (!g.retired) {
          g.writes.end();
          const wait = new AbortController();
          // A writer that does not drain in time is cut short by the retirement below.
          await Promise.race([g.writer, clock.sleep(prefetchTimeoutMs, wait.signal).catch(() => undefined)]);
          wait.abort();
        }
        await retire(g, "memory sources stopped; outside operation canceled");
      }),
    );
    await local.stop();
  };

  return {
    prefetch: async (cue) => {
      const g = snapshot();
      if (!g) return [];
      return readAll(g, cue.agent, async (one, signal) => (await one.prefetch(cueFor(one, cue), signal)).map((line) => ({ ...line, id: idOf(one, line.id) })));
    },
    list: async (agent) => {
      const g = snapshot();
      if (!g) return { memories: [], sources: [] };
      const listing = g.all.filter((one) => one.can.list);
      const groups = await readAll(g, `the memories of ${agent}`, (one, signal) => one.list(agent, signal), listing);
      return {
        memories: groups.flatMap((listed, i) => {
          const one = listing[i];
          return one ? listed.map((m) => ({ ...m, id: idOf(one, m.id), ...(one.name !== localName ? { source: one.name } : {}) })) : [];
        }),
        sources: infoOf(g),
      };
    },
    search: async (query) => {
      const g = snapshot();
      if (!g) return [];
      const groups = await readAll(g, "a search", async (one, signal) => [await one.search(query, signal)]);
      return g.all.map((one, i) => {
        const page = groups[i]?.[0];
        return omitUndefined({
          source: one.name,
          found: (page?.found ?? []).map((found) => ({ ...found, id: idOf(one, found.id), source: one.name })),
          coverage: page ? page.coverage : t("server.memory.coverage.failed"),
        });
      });
    },
    forgetProblem: async (id) => forgetProblem(id),
    forget: async (agent, id) => {
      const problem = forgetProblem(id);
      const g = snapshot();
      if (problem || !g) throw new SourceError(problem ?? t("server.memory.stopped"));
      const [one, own] = user(g.all, id);
      if (one === local) return one.forget(agent, own, new AbortController().signal);
      return leased(g, (signal) => within((s) => one.forget(agent, own, s), writeTimeoutMs, clock, signal));
    },
    add: (note) => enqueue(`a note for ${note.agent} did not reach its source`, (one, signal) => one.add(note, signal)),
    keep: (run) => enqueue(`what ${run.session} learned was not kept outside`, (one, signal) => one.syncTurn(run, signal)),
    endSession: (session) => enqueue(`the end of ${session.session} did not reach its source`, (one, signal) => one.sessionEnded(session, signal)),
    info: async () => {
      const g = snapshot();
      return g ? infoOf(g) : [];
    },
    close,
  };
}
