import { t } from "@vibevalley/i18n";
// What the agents remember: every agent's rows and the outside sources (sources.ts), and the
// orchestrator's own MEMORY.md (agent/brain/memory.ts), which it carries whole rather than recalling from. A note the owner
// writes for the orchestrator starts with 「主人交代：」, so the orchestrator reading it knows whose it is.

import { fromOwner } from "./prompts.ts";
import { type ArchiveListing, type Memory, type MemoryList, type MemorySourceInfo, type Preview, type RecallPreview } from "@vibevalley/protocol";
import { Clock, Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { Agents } from "../agent/agent.ts";
import { archiveFiles, forgetLine, type MemoryLine, readArchive, readMemory, remember, searchArchive } from "@vibevalley/agent/memory";
import { agentHome, Config } from "../base/config.ts";
import { type ApiError, memoriesOf, missing, refused } from "../errors.ts";
import { Setting } from "../setting/setting.ts";
import { everos } from "./everos.ts";
import { type FinishedRun, makeMemories, MemoryRefused, type Note, type RecallCue } from "./memories.ts";
import { nowledge } from "./nowledge.ts";
import { clip, foundText, type Found, inProject, noteMaxChars, recallChars, searchLimit, type SearchQuery, type SearchResult, sourceLabel } from "./recall.ts";
import { type EndedSession, interleave, localSource, makeSources, mergeRecalled, type Source } from "./sources.ts";

export type { EndedSession, FinishedRun, Found, Note, RecallCue, SearchQuery, SearchResult };
export { foundText };

/** What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as told. */
export interface Recalled {
  readonly ids: string[];
  readonly lines: string[];
}

export interface MemoryShape {
  /** An agent's memories: an orchestrator's are the lines of the MEMORY.md in its home; a worker's are rows and its sources'. */
  readonly memoriesOf: (agent: string) => Effect.Effect<MemoryList>;
  readonly remember: (n: Note) => Effect.Effect<Memory, ApiError>;
  readonly forget: (agent: string, id: string) => Effect.Effect<void, ApiError>;
  /** What forget would do, refused as it would be; nothing changes. */
  readonly previewForget: (agent: string, id: string) => Effect.Effect<Preview, ApiError>;
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
  /** An orchestrator's archive: what its compactions folded away. */
  readonly archive: (agent: string, query: string) => ArchiveListing;
  readonly archiveFile: (agent: string, name: string) => string | undefined;
}

export class Memories extends Context.Service<Memories, MemoryShape>()("vibevalley/Memory") {}

const lineMemory = (agent: string, line: MemoryLine, fileTime: number): Memory => {
  const person = line.text.startsWith(fromOwner);
  let at = fileTime;
  if (line.date) {
    const [y, m, d] = line.date.split("-").map(Number);
    at = new Date(y!, m! - 1, d).getTime();
  }
  return {
    id: line.id,
    agent,
    kind: "note",
    text: person ? line.text.slice(fromOwner.length).trim() : line.text,
    at,
    recalled: 0,
    ...(person ? {} : { session: agent }),
  } as Memory;
};

/** Which outside source a configured one is; tests put their own. */
export type BuildSource = (c: Parameters<typeof nowledge>[0], http: HttpClient.HttpClient) => Source | undefined;

const defaultBuild: BuildSource = (c, http) => (c.kind === "nowledge" ? nowledge(c) : c.kind === "everos" ? everos(c, http) : undefined);

export const make = (build: BuildSource = defaultBuild, timeoutMs?: number) =>
  Effect.gen(function* () {
    const config = yield* Config;
    const setting = yield* Setting;
    const agents = yield* Agents;
    const local = yield* makeMemories;
    const http = yield* HttpClient.HttpClient;
    const sources = yield* makeSources({
      local: localSource(local, () => agents.agents().map((a) => a.id)),
      configured: setting.memorySources,
      build: (c) => build(c, http),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    // What an older cut left is cut again in the background.
    yield* Effect.forkScoped(local.recutTerms);
    // An orchestrator carries its whole MEMORY.md into every turn; a worker is reminded of rows by its runs' cues.
    const inFile = (agent: string) => agents.isOrchestrator(agent);
    const homeOf = (agent: string) => agentHome(config, agent);

    const list = (agent: string) => Effect.map(sources.list(agent), (r) => r.memories);

    const write = Effect.fn("Memories.write")(function* (n: Note) {
      const kept = yield* local.write(n).pipe(Effect.mapError((e) => refused(e.message)));
      sources.add(n);
      return kept;
    });

    const forget = (agent: string, id: string) => Effect.mapError(sources.forget(agent, id), (e) => refused(e.message));

    const writeOrchestrator = Effect.fn("Memories.writeOrchestrator")(function* (agent: string, text: string) {
      const body = clip(text.replace(/\s*\n\s*/g, " "), noteMaxChars);
      if (body === "") return yield* Effect.fail(refused(t("server.memory.empty")));
      const at = yield* Clock.currentTimeMillis;
      const written = yield* Effect.try({
        try: () => remember(homeOf(agent), fromOwner + body, new Date(at)),
        catch: () => refused(t("server.memory.fileFailed")),
      });
      return lineMemory(agent, written, at);
    });

    const orchestrator = (agent: string): MemoryList => {
      const snapshot = readMemory(homeOf(agent));
      return {
        file: snapshot.file,
        memories: snapshot.lines.map((l) => lineMemory(agent, l, snapshot.updatedAt)).reverse(),
        carried: snapshot.carried,
        sources: [],
      };
    };

    const preview = (agent: string, project: string, text: string) =>
      Effect.map(sources.prefetch({ agent, project, text, peek: true }), (groups): RecallPreview => {
        const lines = mergeRecalled(groups);
        return { lines: lines.map((l) => l.line), chars: lines.reduce((n, l) => n + l.line.length + 1, 0), limit: recallChars };
      });

    // forget and its dry run judge by this: the memory is there, and its source lets it be forgotten here.
    const fileRefused = (e: unknown) => refused(e instanceof Error ? e.message : String(e));
    const forgettable = Effect.fn("Memories.forgettable")(function* (agent: string, id: string) {
      const problem = inFile(agent) ? undefined : sources.forgetProblem(id);
      if (problem) return yield* Effect.fail(refused(problem));
      const listed = inFile(agent) ? yield* Effect.try({ try: () => orchestrator(agent), catch: fileRefused }) : yield* sources.list(agent);
      const m = listed.memories.find((x) => x.id === id);
      if (!m) return yield* Effect.fail(missing(t("server.memory.noMemory", { agent, id }), [memoriesOf(agent)]));
      return m;
    });

    const shape: MemoryShape = {
      memoriesOf: (agent) => (inFile(agent) ? Effect.sync(() => orchestrator(agent)) : sources.list(agent)),
      remember: (n) => (inFile(n.agent) ? writeOrchestrator(n.agent, n.text) : write(n)),
      forget: (agent, id) =>
        Effect.andThen(
          forgettable(agent, id),
          inFile(agent) ? Effect.try({ try: () => forgetLine(homeOf(agent), id), catch: fileRefused }) : forget(agent, id),
        ),
      previewForget: (agent, id) =>
        Effect.map(forgettable(agent, id), (m) => ({
          does: [inFile(agent) ? t("server.memory.forgetOrchestrator", { text: m.text }) : t("server.memory.forget", { agent, text: m.text })],
        })),
      recallOf: (agent, project, text) => (inFile(agent) ? Effect.fail(refused(t("server.memory.orchestratorRecall"))) : preview(agent, project, text)),
      recall: Effect.fn("Memories.recall")(function* (cue) {
        const told = mergeRecalled(yield* sources.prefetch(cue));
        const ids = told.map((l) => l.id).filter((id) => id !== "");
        yield* local.markRecalled(ids.filter((id) => !id.includes(":")));
        return { ids, lines: told.map((l) => l.line) };
      }),
      search: Effect.fn("Memories.search")(function* (q) {
        const query = { ...q, limit: q.limit > 0 ? q.limit : searchLimit };
        const pages = yield* sources.search(query);
        const coverage = pages.flatMap((page) => {
          const notes = page.coverage ? [page.coverage] : [];
          if (query.project && page.found.some((f) => f.scope.kind === "unknown")) notes.push(t("server.memory.coverage.unconfirmed"));
          return notes.map((note) => t("server.memory.coverage.note", { source: sourceLabel(page.source), note }));
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
      archive: (agent, query) => ({
        files: archiveFiles(homeOf(agent)),
        hits: query.trim() ? searchArchive(homeOf(agent), query) : [],
      }),
      archiveFile: (agent, name) => readArchive(homeOf(agent), name),
    };
    return shape;
  });

export const layer = Layer.effect(Memories, make());

export { MemoryRefused };
