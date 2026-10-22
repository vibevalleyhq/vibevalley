// What the agents remember: every agent's rows and the outside sources (sources.ts), and the
// assistant's own MEMORY.md (agent/brain/memory.ts), which it carries whole rather than recalling from. A note the owner
// writes for the assistant starts with 「主人交代：」, so the assistant reading it knows whose it is.

import { join } from "node:path";
import { type ArchiveListing, assistantAgent, type Memory, type MemoryList, type MemorySourceInfo, type RecallPreview } from "@vibevalley/protocol";
import { Context, Effect, FiberSet, Layer } from "effect";
import { Agents } from "../agent/agent.ts";
import { archiveFiles, forgetLine, type MemoryLine, readArchive, readMemory, remember, searchArchive } from "../agent/brain/memory.ts";
import { Settings } from "../base/config.ts";
import { type ApiError, refused } from "../errors.ts";
import { Setting } from "../setting/setting.ts";
import { everos } from "./everos.ts";
import { type FinishedRun, makeMemories, MemoryRefused, type Note, type RecallCue } from "./memories.ts";
import { nowledge } from "./nowledge.ts";
import { clip, foundText, type Found, fromOwner, localName, noteMaxChars, recallChars, searchLimit, type SearchQuery } from "./recall.ts";
import { cueFor, type EndedSession, idOf, interleave, localSource, mergeRecalled, owner, type RecalledLine, type Source, Sources } from "./sources.ts";

export type { EndedSession, FinishedRun, Found, Note, RecallCue, SearchQuery };
export { foundText };

/** What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as told. */
export interface Recalled {
  readonly ids: string[];
  readonly lines: string[];
}

export const assistantHome = (home: string) => join(home, "assistant");

export interface MemoryShape {
  /** An agent's memories: the assistant's are MEMORY.md's lines; every other agent's are rows and its sources'. */
  readonly memoriesOf: (agent: string) => Effect.Effect<MemoryList>;
  readonly remember: (n: Note) => Effect.Effect<Memory, ApiError>;
  readonly forgetOf: (agent: string, id: string) => Effect.Effect<void, ApiError>;
  readonly recallOf: (agent: string, project: string, text: string) => Effect.Effect<RecallPreview, ApiError>;
  /** What a run is told as it starts; only what is told is counted as recalled. */
  readonly recall: (cue: RecallCue) => Effect.Effect<Recalled>;
  /** Behind memory_search: every source's best, taken in turns, the same memory once. */
  readonly search: (q: SearchQuery) => Effect.Effect<Found[]>;
  /** The local rows keep the run before this returns; the other sources get it in the background. */
  readonly keep: (run: FinishedRun) => Effect.Effect<void>;
  readonly endSession: (s: EndedSession) => Effect.Effect<void>;
  readonly write: (n: Note) => Effect.Effect<Memory, ApiError>;
  readonly list: (agent: string) => Effect.Effect<Memory[]>;
  readonly sources: () => MemorySourceInfo[];
  readonly writeAssistant: (text: string) => Effect.Effect<Memory, ApiError>;
  readonly archive: (query: string) => ArchiveListing;
  readonly archiveFile: (name: string) => string | undefined;
}

export class Memories extends Context.Service<Memories, MemoryShape>()("vibevalley/Memory") {}

const lineMemory = (line: MemoryLine, fileTime: number): Memory => {
  const person = line.text.startsWith(fromOwner);
  let at = fileTime;
  if (line.date) {
    const [y, m, d] = line.date.split("-").map(Number);
    at = new Date(y!, m! - 1, d!).getTime();
  }
  return {
    id: line.id,
    agent: assistantAgent,
    kind: "note",
    text: person ? line.text.slice(fromOwner.length).trim() : line.text,
    at,
    recalled: 0,
    ...(person ? {} : { session: assistantAgent }),
  } as Memory;
};

/** Which outside source a configured one is; tests put their own. */
export type BuildSource = (c: Parameters<typeof nowledge>[0]) => Source | undefined;

const defaultBuild: BuildSource = (c) => (c.kind === "nowledge" ? nowledge(c) : c.kind === "everos" ? everos(c) : undefined);

export const make = (build: BuildSource = defaultBuild, timeoutMs?: number) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const setting = yield* Setting;
    const agents = yield* Agents;
    const local = yield* makeMemories;
    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const run = yield* FiberSet.makeRuntimePromise<never>();
    const forkHere = yield* FiberSet.makeRuntime<never>();
    const log = (line: string) => void forkHere(Effect.logWarning(line));
    const sources = new Sources(
      localSource(local, () => agents.agents().map((a) => a.id), run),
      setting.memorySources,
      build,
      log,
      timeoutMs,
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => sources.stop()));
    // What an older cut left is cut again in the background.
    yield* Effect.forkScoped(local.recutTerms);
    const home = assistantHome(config.home);

    const prefetchAll = (cue: RecallCue) =>
      sources.askAll(cue.agent, async (one, signal) =>
        (await one.prefetch(cueFor(one, cue), signal)).map((l): RecalledLine => ({ ...l, id: idOf(one, l.id) })),
      );

    const list = (agent: string) =>
      Effect.promise(async () => {
        const listing = sources.current().filter((one) => one.can.list);
        const groups = await sources.askAll(`the memories of ${agent}`, (one, signal) => one.list(agent, signal), listing);
        return groups.flatMap((listed, i) => {
          const one = listing[i]!;
          return listed.map((m) => ({ ...m, id: idOf(one, m.id), ...(one.name !== localName ? { source: one.name } : {}) }));
        });
      });

    const write = (n: Note) =>
      Effect.gen(function* () {
        const all = sources.current();
        const kept = yield* local.write(n).pipe(Effect.mapError((e) => refused(e.message)));
        for (const one of all.slice(1)) sources.later(`a note for ${n.agent} did not reach ${one.name}`, (signal) => one.add(n, signal).then(() => {}));
        return kept;
      });

    const forget = (agent: string, id: string) =>
      Effect.gen(function* () {
        const [one, own] = owner(sources.current(), id);
        if (!one.can.forget)
          return yield* Effect.fail(
            refused(`${one.name === "nowledge" ? "Nowledge Mem" : one.name === "everos" ? "EverOS" : one.name} 里的记忆到它自己那里删`),
          );
        yield* Effect.promise(() => one.forget(agent, own));
      });

    const writeAssistant = (text: string) =>
      Effect.gen(function* () {
        const body = clip(text.replace(/\s*\n\s*/g, " "), noteMaxChars);
        if (body === "") return yield* Effect.fail(refused("要记的话是空的"));
        const written = yield* Effect.try({ try: () => remember(home, fromOwner + body), catch: () => refused("没记下来：MEMORY.md 写不进去") });
        return lineMemory(written, Date.now());
      });

    const assistant = (): MemoryList => {
      const snapshot = readMemory(home);
      return { file: snapshot.file, memories: snapshot.lines.map((l) => lineMemory(l, snapshot.updatedAt)).reverse(), carried: snapshot.carried, sources: [] };
    };

    const preview = (agent: string, project: string, text: string) =>
      Effect.promise(async (): Promise<RecallPreview> => {
        const lines = mergeRecalled(await prefetchAll({ agent, project, text, peek: true }));
        return { lines: lines.map((l) => l.line), chars: lines.reduce((n, l) => n + l.line.length + 1, 0), limit: recallChars };
      });

    const shape: MemoryShape = {
      memoriesOf: (agent) =>
        agent === assistantAgent ? Effect.sync(assistant) : Effect.map(list(agent), (memories) => ({ memories, sources: sources.info() })),
      remember: (n) => (n.agent === assistantAgent ? writeAssistant(n.text) : write(n)),
      forgetOf: (agent, id) => (agent === assistantAgent ? Effect.sync(() => forgetLine(home, id)) : forget(agent, id)),
      recallOf: (agent, project, text) => (agent === assistantAgent ? Effect.fail(refused("管家不靠想起：它每次带着整份记性")) : preview(agent, project, text)),
      recall: (cue) =>
        Effect.gen(function* () {
          const told = mergeRecalled(yield* Effect.promise(() => prefetchAll(cue)));
          const ids = told.map((l) => l.id).filter((id) => id !== "");
          yield* local.markRecalled(ids.filter((id) => !id.includes(":")));
          return { ids, lines: told.map((l) => l.line) };
        }),
      search: (q) =>
        Effect.promise(async () => {
          const query = { ...q, limit: q.limit > 0 ? q.limit : searchLimit };
          const groups = await sources.askAll("a search", async (one, signal) =>
            (await one.search(query, signal)).map((f) => ({ ...f, id: idOf(one, f.id), source: one.name })),
          );
          return interleave(
            groups,
            (f) => f.text,
            () => true,
          ).slice(0, query.limit);
        }),
      keep: (r) =>
        Effect.gen(function* () {
          const all = sources.current();
          yield* local.keep(r);
          for (const one of all.slice(1)) sources.later(`${one.name} did not keep what ${r.session} learned`, (signal) => one.syncTurn(r, signal));
        }),
      endSession: (s) =>
        Effect.sync(() => {
          for (const one of sources.current().slice(1))
            sources.later(`${one.name} did not take the end of ${s.session}`, (signal) => one.sessionEnded(s, signal));
        }),
      write,
      list,
      sources: () => sources.info(),
      writeAssistant,
      archive: (query) => ({
        files: archiveFiles(home),
        hits: query.trim() ? searchArchive(home, query) : [],
      }),
      archiveFile: (name) => readArchive(home, name),
    };
    return shape;
  });

export const layer = Layer.effect(Memories, make());

export { MemoryRefused };
