// Where memories live: this farm's database, always there and
// first, and a memory service outside it (Nowledge Mem, EverOS), modeled on Hermes's MemoryProvider. Every read asks them
// all at once and takes their answers in turns; a source outside the farm that fails or is slow gives nothing, with a line
// in the log; writes to one go in the background, in order.

import type { Memory, MemorySourceInfo } from "@vibevalley/protocol";
import { Effect } from "effect";
import type { MemorySourceConfig } from "../setting/rules.ts";
import type { FinishedRun, Memories, Note, RecallCue } from "./memories.ts";
import { lineOf, localName, memoryLikeness, pick, recallChars, recallCount, search, type SearchQuery, type SourceSearch, sourceLabels } from "./recall.ts";
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

/** A source. Its methods may fail (a service down, a bad answer): the caller logs and goes on. */
export interface Source {
  /** Prefixes the ids of the memories it gives, except the local one's. */
  readonly name: string;
  /** Configured and ready, by config alone: undefined, or why not. */
  readonly unavailable: () => string | undefined;
  readonly stop: () => Promise<void>;
  /** What the agent should recall as a run starts, best first. */
  readonly prefetch: (cue: RecallCue, signal: AbortSignal) => Promise<RecalledLine[]>;
  readonly syncTurn: (run: FinishedRun, signal: AbortSignal) => Promise<void>;
  readonly sessionEnded: (s: EndedSession, signal: AbortSignal) => Promise<void>;
  readonly search: (q: SearchQuery, signal: AbortSignal) => Promise<SourceSearch>;
  readonly list: (agent: string, signal: AbortSignal) => Promise<Memory[]>;
  readonly add: (n: Note, signal: AbortSignal) => Promise<Memory | undefined>;
  readonly forget: (agent: string, id: string, signal: AbortSignal) => Promise<void>;
  readonly can: Abilities;
}

/** How long a source outside the farm may take to answer a read: a run waiting on it is the owner waiting. */
export const prefetchTimeoutMs = 2_000;
/** A write goes in the background, so it may take longer; one that hangs still must not hold the queue for ever. */
export const writeTimeoutMs = 30_000;
const writeQueue = 256;

/** The local source: the memory table, picked by recall.ts. Nothing is marked recalled here: the caller marks those it keeps. */
export function localSource(m: Memories, profiles: () => string[], run: <A>(e: Effect.Effect<A, unknown>) => Promise<A>): Source {
  return {
    name: localName,
    unavailable: () => undefined,
    stop: async () => {},
    prefetch: async (cue) => {
      let picked: Memory[];
      if (cue.peek) {
        if (cue.project === "") return [];
        const all = await run(m.list(cue.agent));
        picked = pick(all, {
          project: cue.project,
          text: cue.text,
          now: Date.now(),
          matches: await run(m.matches(cue.agent, cue.text)),
        });
      } else picked = await run(m.recallable(cue));
      return picked.map((x, i) => ({
        id: x.id,
        line: lineOf(x, cue.project),
        score: picked.length - i,
      }));
    },
    syncTurn: (r) => run(m.keep(r)),
    sessionEnded: async () => {},
    search: async (q) => {
      const agents = q.agent === "" ? profiles() : [q.agent];
      const all: Memory[] = [];
      const matches: Record<string, number> = {};
      for (const agent of agents) {
        all.push(...(await run(m.list(agent))));
        Object.assign(matches, await run(m.matches(agent, q.text)));
      }
      return { found: search(all, q, matches) };
    },
    list: (agent) => run(m.listed(agent)),
    add: (n) => run(m.write(n)),
    forget: (agent, id) => run(m.forget(agent, id)),
    can: { list: true, forget: true, transcripts: false },
  };
}

/** The local source's ids go as they are; another's carry its name: name:id. */
export const idOf = (one: Source, id: string) => (one.name === localName || id === "" ? id : `${one.name}:${id}`);

/** Which source an id is from, and the id as that source knows it. */
export function owner(all: readonly Source[], id: string): [Source, string] {
  const colon = id.indexOf(":");
  if (colon >= 0) {
    const named = all.find((s) => s.name === id.slice(0, colon));
    if (named) return [named, id.slice(colon + 1)];
  }
  return [all[0]!, id];
}

/** The cue as one source gets it: only its own ids to skip, as it knows them. */
export function cueFor(one: Source, cue: RecallCue): RecallCue {
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
export function interleave<T>(groups: readonly (readonly T[])[], text: (t: T) => string, keep: (t: T) => boolean): T[] {
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
      if (texts.includes(text(one)) || seen.some((t) => memoryLikeness(t, terms) >= 0.8)) continue;
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

interface Generation {
  readonly all: Source[];
  readonly off: MemorySourceInfo[];
  readonly control: AbortController;
  readonly active: Set<Promise<unknown>>;
  queue: Promise<void>;
  closing?: Promise<void>;
}

/** A canceled operation has no further access to its source; adapters seal their resources when stopped. */
const abortable = <A>(work: () => Promise<A>, signal: AbortSignal): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });

/** Owns source generations and every accepted operation, including retirement and shutdown. */
export class Sources {
  private current: Generation | undefined;
  private readonly generations = new Set<Generation>();
  private built: string | undefined;
  private stopped = false;
  private queued = 0;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly local: Source,
    private readonly configured: () => readonly MemorySourceConfig[],
    private readonly build: (c: MemorySourceConfig) => Source | undefined,
    private readonly log: (line: string) => void,
    private readonly timeoutMs = prefetchTimeoutMs,
  ) {}

  private snapshot(): Generation | undefined {
    if (this.stopped) return undefined;
    const configured = this.configured();
    const key = JSON.stringify(configured);
    if (key !== this.built) {
      if (this.current) void this.retire(this.current, "memory sources changed; outside operation canceled");
      const next: Generation = {
        all: [this.local],
        off: [],
        control: new AbortController(),
        active: new Set(),
        queue: Promise.resolve(),
      };
      this.current = next;
      this.generations.add(next);
      this.built = key;
      for (const c of configured) {
        const name = c.kind;
        const off = (why: string) =>
          next.off.push({
            name,
            label: sourceLabels[name] ?? name,
            on: false,
            canList: false,
            canForget: false,
            transcripts: false,
            off: why,
          });
        if (!c.enabled) {
          off("没打开");
          continue;
        }
        const one = this.build(c);
        if (!one) {
          off("不认识这种来源");
          continue;
        }
        const why = one.unavailable();
        if (why) {
          this.log(`memory from ${name} is off: ${why}`);
          off(why);
          continue;
        }
        next.all.push(one);
      }
    }
    return this.current;
  }

  private lease<A>(generation: Generation, signal: AbortSignal, work: () => Promise<A>): Promise<A> {
    const pending = abortable(work, signal);
    generation.active.add(pending);
    void pending.then(
      () => generation.active.delete(pending),
      () => generation.active.delete(pending),
    );
    return pending;
  }

  private retire(generation: Generation, why: string): Promise<void> {
    if (generation.closing) return generation.closing;
    generation.control.abort(new Error(why));
    generation.closing = (async () => {
      await generation.queue;
      await Promise.allSettled([...generation.active]);
      await Promise.all(
        generation.all
          .filter((one) => one !== this.local)
          .map(async (one) => {
            try {
              await abortable(one.stop, AbortSignal.timeout(prefetchTimeoutMs));
            } catch (e) {
              this.log(`stopping memory source ${one.name}: ${String(e)}`);
            }
          }),
      );
      this.generations.delete(generation);
    })();
    return generation.closing;
  }

  private readAll<T>(generation: Generation, what: string, ask: (one: Source, signal: AbortSignal) => Promise<T[]>, all = generation.all): Promise<T[][]> {
    return Promise.all(
      all.map(async (one) => {
        const signal = one === this.local ? new AbortController().signal : AbortSignal.any([generation.control.signal, AbortSignal.timeout(this.timeoutMs)]);
        try {
          return await this.lease(generation, signal, () => ask(one, signal));
        } catch (e) {
          this.log(`memory from ${one.name} for ${what}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );
  }

  private enqueue(what: string, write: (one: Source, signal: AbortSignal) => Promise<unknown>) {
    const generation = this.snapshot();
    if (!generation) return;
    for (const one of generation.all.slice(1)) {
      if (this.queued >= writeQueue) {
        this.log(`${what}: too many writes waiting, dropped`);
        continue;
      }
      this.queued++;
      generation.queue = generation.queue.then(async () => {
        const signal = AbortSignal.any([generation.control.signal, AbortSignal.timeout(writeTimeoutMs)]);
        try {
          await this.lease(generation, signal, () => write(one, signal));
        } catch (e) {
          this.log(`${what} (${one.name}): ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          this.queued--;
        }
      });
    }
  }

  prefetch(cue: RecallCue): Promise<RecalledLine[][]> {
    const generation = this.snapshot();
    return generation
      ? this.readAll(generation, cue.agent, async (one, signal) =>
          (await one.prefetch(cueFor(one, cue), signal)).map((line) => ({
            ...line,
            id: idOf(one, line.id),
          })),
        )
      : Promise.resolve([]);
  }

  async list(agent: string): Promise<{ memories: Memory[]; sources: MemorySourceInfo[] }> {
    const generation = this.snapshot();
    if (!generation) return { memories: [], sources: [] };
    const listing = generation.all.filter((one) => one.can.list);
    const groups = await this.readAll(generation, `the memories of ${agent}`, (one, signal) => one.list(agent, signal), listing);
    return {
      memories: groups.flatMap((listed, i) => {
        const one = listing[i]!;
        return listed.map((m) => ({
          ...m,
          id: idOf(one, m.id),
          ...(one.name !== localName ? { source: one.name } : {}),
        }));
      }),
      sources: this.infoOf(generation),
    };
  }

  async search(query: SearchQuery): Promise<(SourceSearch & { source: string })[]> {
    const generation = this.snapshot();
    if (!generation) return [];
    const groups = await this.readAll(generation, "a search", async (one, signal) => [await one.search(query, signal)]);
    return generation.all.map((one, i) => {
      const page = groups[i]?.[0];
      return {
        source: one.name,
        found: (page?.found ?? []).map((found) => ({
          ...found,
          id: idOf(one, found.id),
          source: one.name,
        })),
        coverage: page ? page.coverage : "读取失败、已取消或超时，未包含此来源",
      };
    });
  }

  /** Why the memory with this id cannot be forgotten here; forget refuses for the same reason. */
  forgetProblem(id: string): string | undefined {
    const generation = this.snapshot();
    if (!generation) return "记性来源已经停下";
    const [one] = owner(generation.all, id);
    return one.can.forget ? undefined : `${sourceLabels[one.name] ?? one.name} 里的记忆到它自己那里删`;
  }

  async forget(agent: string, id: string): Promise<void> {
    const problem = this.forgetProblem(id);
    if (problem) throw new Error(problem);
    const generation = this.snapshot()!;
    const [one, own] = owner(generation.all, id);
    const signal = one === this.local ? new AbortController().signal : AbortSignal.any([generation.control.signal, AbortSignal.timeout(writeTimeoutMs)]);
    await this.lease(generation, signal, () => one.forget(agent, own, signal));
  }

  add(note: Note) {
    this.enqueue(`a note for ${note.agent} did not reach its source`, (one, signal) => one.add(note, signal));
  }

  keep(run: FinishedRun) {
    this.enqueue(`what ${run.session} learned was not kept outside`, (one, signal) => one.syncTurn(run, signal));
  }

  endSession(session: EndedSession) {
    this.enqueue(`the end of ${session.session} did not reach its source`, (one, signal) => one.sessionEnded(session, signal));
  }

  private infoOf(generation: Generation): MemorySourceInfo[] {
    return [
      ...generation.all.map((one) => ({
        name: one.name,
        label: sourceLabels[one.name] ?? one.name,
        on: true,
        canList: one.can.list,
        canForget: one.can.forget,
        transcripts: one.can.transcripts,
      })),
      ...generation.off,
    ];
  }

  info(): MemorySourceInfo[] {
    const generation = this.snapshot();
    return generation ? this.infoOf(generation) : [];
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.all(
      [...this.generations].map(async (g) => {
        if (!g.closing) await abortable(() => g.queue, AbortSignal.timeout(prefetchTimeoutMs)).catch(() => {});
        await this.retire(g, "memory sources stopped; outside operation canceled");
      }),
    ).then(() => this.local.stop());
    return this.stopping;
  }
}
