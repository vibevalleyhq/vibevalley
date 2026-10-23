// What the agents remember: every agent's rows and the outside sources (sources.ts), and the
// orchestrator's own MEMORY.md (agent/brain/memory.ts), which it carries whole rather than recalling from. A note the owner
// writes for the orchestrator starts with 「主人交代：」, so the orchestrator reading it knows whose it is.

import { join } from "node:path";
import {
  type ArchiveListing,
  orchestratorAgent,
  type Memory,
  type MemoryList,
  type MemorySourceInfo,
  type Preview,
  type RecallPreview,
} from "@vibevalley/protocol";
import { Context, Effect, FiberSet, Layer } from "effect";
import { Agents } from "../agent/agent.ts";
import { archiveFiles, forgetLine, type MemoryLine, readArchive, readMemory, remember, searchArchive } from "../agent/brain/memory.ts";
import { Settings } from "../base/config.ts";
import { type ApiError, memoriesOf, missing, refused } from "../errors.ts";
import { Setting } from "../setting/setting.ts";
import { everos } from "./everos.ts";
import { type FinishedRun, makeMemories, MemoryRefused, type Note, type RecallCue } from "./memories.ts";
import { nowledge } from "./nowledge.ts";
import {
  clip,
  foundText,
  type Found,
  fromOwner,
  inProject,
  noteMaxChars,
  recallChars,
  searchLimit,
  type SearchQuery,
  type SearchResult,
  sourceLabels,
} from "./recall.ts";
import { type EndedSession, interleave, localSource, mergeRecalled, type Source, Sources } from "./sources.ts";

export type { EndedSession, FinishedRun, Found, Note, RecallCue, SearchQuery, SearchResult };
export { foundText };

/** What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as told. */
export interface Recalled {
  readonly ids: string[];
  readonly lines: string[];
}

export const orchestratorHome = (home: string) => join(home, "orchestrator");

export interface MemoryShape {
  /** An agent's memories: the orchestrator's are MEMORY.md's lines; every other agent's are rows and its sources'. */
  readonly memoriesOf: (agent: string) => Effect.Effect<MemoryList>;
  readonly remember: (n: Note) => Effect.Effect<Memory, ApiError>;
  readonly forgetOf: (agent: string, id: string) => Effect.Effect<void, ApiError>;
  /** What forgetOf would do, refused as it would be; nothing changes. */
  readonly previewForgetOf: (agent: string, id: string) => Effect.Effect<Preview, ApiError>;
  readonly recallOf: (agent: string, project: string, text: string) => Effect.Effect<RecallPreview, ApiError>;
  /** What a run is told as it starts; only what is told is counted as recalled. */
  readonly recall: (cue: RecallCue) => Effect.Effect<Recalled>;
  /** Behind memory_search: every source's best, taken in turns, the same memory once. */
  readonly search: (q: SearchQuery) => Effect.Effect<SearchResult>;
  /** The local rows keep the run before this returns; the other sources get it in the background. */
  readonly keep: (run: FinishedRun) => Effect.Effect<void>;
  readonly endSession: (s: EndedSession) => Effect.Effect<void>;
  readonly write: (n: Note) => Effect.Effect<Memory, ApiError>;
  readonly list: (agent: string) => Effect.Effect<Memory[]>;
  readonly sources: () => MemorySourceInfo[];
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
    agent: orchestratorAgent,
    kind: "note",
    text: person ? line.text.slice(fromOwner.length).trim() : line.text,
    at,
    recalled: 0,
    ...(person ? {} : { session: orchestratorAgent }),
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
    const home = orchestratorHome(config.home);

    const list = (agent: string) => Effect.promise(async () => (await sources.list(agent)).memories);

    const write = Effect.fn("Memories.write")(function* (n: Note) {
      const kept = yield* local.write(n).pipe(Effect.mapError((e) => refused(e.message)));
      sources.add(n);
      return kept;
    });

    const forget = (agent: string, id: string) =>
      Effect.tryPromise({ try: () => sources.forget(agent, id), catch: (e) => refused(e instanceof Error ? e.message : String(e)) });

    const writeOrchestrator = Effect.fn("Memories.writeOrchestrator")(function* (text: string) {
      const body = clip(text.replace(/\s*\n\s*/g, " "), noteMaxChars);
      if (body === "") return yield* Effect.fail(refused("要记的话是空的"));
      const written = yield* Effect.try({ try: () => remember(home, fromOwner + body), catch: () => refused("没记下来：MEMORY.md 写不进去") });
      return lineMemory(written, Date.now());
    });

    const orchestrator = (): MemoryList => {
      const snapshot = readMemory(home);
      return { file: snapshot.file, memories: snapshot.lines.map((l) => lineMemory(l, snapshot.updatedAt)).reverse(), carried: snapshot.carried, sources: [] };
    };

    const preview = (agent: string, project: string, text: string) =>
      Effect.promise(async (): Promise<RecallPreview> => {
        const lines = mergeRecalled(await sources.prefetch({ agent, project, text, peek: true }));
        return { lines: lines.map((l) => l.line), chars: lines.reduce((n, l) => n + l.line.length + 1, 0), limit: recallChars };
      });

    // forgetOf and its dry run judge by this: the memory is there, and its source lets it be forgotten here.
    const forgettable = Effect.fn("Memories.forgettable")(function* (agent: string, id: string) {
      const problem = agent === orchestratorAgent ? undefined : sources.forgetProblem(id);
      if (problem) return yield* Effect.fail(refused(problem));
      const listed = agent === orchestratorAgent ? orchestrator() : yield* Effect.promise(() => sources.list(agent));
      const m = listed.memories.find((x) => x.id === id);
      if (!m) return yield* Effect.fail(missing(`${agent} 的记性里没有 ${id}`, [memoriesOf(agent)]));
      return m;
    });

    const shape: MemoryShape = {
      memoriesOf: (agent) => (agent === orchestratorAgent ? Effect.sync(orchestrator) : Effect.promise(() => sources.list(agent))),
      remember: (n) => (n.agent === orchestratorAgent ? writeOrchestrator(n.text) : write(n)),
      forgetOf: (agent, id) =>
        Effect.andThen(forgettable(agent, id), agent === orchestratorAgent ? Effect.sync(() => forgetLine(home, id)) : forget(agent, id)),
      previewForgetOf: (agent, id) =>
        Effect.map(forgettable(agent, id), (m) => ({
          does: [agent === orchestratorAgent ? `从管家的 MEMORY.md 删掉这一行：「${m.text}」` : `从 ${agent} 的记性里忘掉：「${m.text}」`],
        })),
      recallOf: (agent, project, text) =>
        agent === orchestratorAgent ? Effect.fail(refused("管家不靠想起：它每次带着整份记性")) : preview(agent, project, text),
      recall: Effect.fn("Memories.recall")(function* (cue) {
        const told = mergeRecalled(yield* Effect.promise(() => sources.prefetch(cue)));
        const ids = told.map((l) => l.id).filter((id) => id !== "");
        yield* local.markRecalled(ids.filter((id) => !id.includes(":")));
        return { ids, lines: told.map((l) => l.line) };
      }),
      search: (q) =>
        Effect.promise(async () => {
          const query = { ...q, limit: q.limit > 0 ? q.limit : searchLimit };
          const pages = await sources.search(query);
          const coverage = pages.flatMap((page) => {
            const notes = page.coverage ? [page.coverage] : [];
            if (query.project && page.found.some((f) => f.scope.kind === "unknown")) notes.push("有命中的项目范围未经确认，已从本项目检索中排除");
            return notes.map((note) => `${sourceLabels[page.source] ?? page.source}：${note}`);
          });
          const found = interleave(
            pages.map((page) => page.found),
            (f) => f.text,
            (f) => inProject(f.scope, query.project),
          ).slice(0, query.limit);
          return { found, coverage };
        }),
      keep: Effect.fn("Memories.keep")(function* (r) {
        yield* local.keep(r);
        sources.keep(r);
      }),
      endSession: (s) => Effect.sync(() => sources.endSession(s)),
      write,
      list,
      sources: () => sources.info(),
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
