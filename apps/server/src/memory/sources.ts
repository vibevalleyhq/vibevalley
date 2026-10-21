// Where memories live: this farm's database, always there and
// first, and a memory service outside it (Nowledge Mem, EverOS), modeled on Hermes's MemoryProvider. Every read asks them
// all at once and takes their answers in turns; a source outside the farm that fails or is slow gives nothing, with a line
// in the log; writes to one go in the background, in order.

import type { Memory, MemorySourceInfo } from "@vibevalley/protocol";
import { Effect } from "effect";
import type { MemorySourceConfig } from "../setting/rules.ts";
import type { FinishedRun, Memories, Note, RecallCue } from "./memories.ts";
import { type Found, lineOf, localName, memoryLikeness, pick, recallChars, recallCount, search, type SearchQuery, sourceLabels } from "./recall.ts";
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
  readonly search: (q: SearchQuery, signal: AbortSignal) => Promise<Found[]>;
  readonly list: (agent: string, signal: AbortSignal) => Promise<Memory[]>;
  readonly add: (n: Note, signal: AbortSignal) => Promise<Memory | undefined>;
  readonly forget: (agent: string, id: string) => Promise<void>;
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
        picked = pick(all, { project: cue.project, text: cue.text, now: Date.now(), matches: await run(m.matches(cue.agent, cue.text)) });
      } else picked = await run(m.recallable(cue));
      return picked.map((x, i) => ({ id: x.id, line: lineOf(x, cue.project), score: picked.length - i }));
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
      return search(all, q, matches);
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

/** The sources, following the settings: built again whenever their settings change, used from the next read or write. */
export class Sources {
  private all: Source[];
  private off: MemorySourceInfo[] = [];
  private built: string | undefined;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(
    private readonly local: Source,
    private readonly configured: () => readonly MemorySourceConfig[],
    private readonly build: (c: MemorySourceConfig) => Source | undefined,
    private readonly log: (line: string) => void,
    private readonly timeoutMs = prefetchTimeoutMs,
  ) {
    this.all = [local];
  }

  current(): Source[] {
    if (this.stopped) return [this.local];
    const configured = this.configured();
    const key = JSON.stringify(configured);
    if (key !== this.built) {
      for (const one of this.all) if (one !== this.local) void one.stop();
      this.all = [this.local];
      this.off = [];
      this.built = key;
      for (const c of configured) {
        const name = c.kind;
        const off = (why: string) =>
          this.off.push({
            name,
            label: sourceLabels[name] ?? name,
            on: false,
            canList: false,
            canForget: false,
            transcripts: false,
            off: why,
          } as MemorySourceInfo);
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
        this.all.push(one);
      }
    }
    return [...this.all];
  }

  /** Asks every source at once; the local one is waited for, any other only up to the timeout. */
  async askAll<T>(what: string, ask: (one: Source, signal: AbortSignal) => Promise<T[]>, sources = this.current()): Promise<T[][]> {
    return Promise.all(
      sources.map(async (one) => {
        const signal = one === this.local ? new AbortController().signal : AbortSignal.timeout(this.timeoutMs);
        try {
          if (one === this.local) return await ask(one, signal);
          return await Promise.race([
            ask(one, signal),
            new Promise<never>((_, reject) =>
              signal.addEventListener("abort", () => reject(new Error(`took longer than ${this.timeoutMs} ms`)), { once: true }),
            ),
          ]);
        } catch (e) {
          this.log(`memory from ${one.name} for ${what}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );
  }

  /** Writes to sources outside the farm go one at a time in the background, in the order they were made. */
  later(what: string, write: (signal: AbortSignal) => Promise<void>) {
    if (this.stopped) return;
    if (this.queued >= writeQueue) return this.log(`${what}: too many writes waiting, dropped`);
    this.queued++;
    this.queue = this.queue.then(async () => {
      try {
        await write(AbortSignal.timeout(writeTimeoutMs));
      } catch (e) {
        this.log(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.queued--;
      }
    });
  }

  info(): MemorySourceInfo[] {
    const on = this.current().map(
      (one) =>
        ({
          name: one.name,
          label: sourceLabels[one.name] ?? one.name,
          on: true,
          canList: one.can.list,
          canForget: one.can.forget,
          transcripts: one.can.transcripts,
        }) as MemorySourceInfo,
    );
    return [...on, ...this.off];
  }

  /** Waits for the writes already queued; none are taken after. */
  async stop() {
    this.stopped = true;
    await this.queue;
    for (const one of this.all) await one.stop();
  }
}
