import { Context, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";

import { archiveFiles, type MemoryPort, parseMemoryLines, readArchive, searchArchive } from "@vibevalley/agent/memory";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { type ApiError, memoriesOf, missing, refused } from "@/errors.ts";
import { agentHome, ServerConfig } from "@/infra/config.ts";
import { Setting } from "@/setting/setting.ts";

import { everos } from "./everos.ts";
import { loadSegmenter } from "./gse.ts";
import { nowledge } from "./nowledge.ts";
import { carriedMemory, fromOwner } from "./prompts.ts";
import { foundText, type Found, inProject, recallChars, searchLimit, type SearchQuery, type SearchResult, sourceLabel } from "./recall.ts";
import { type EndedSession, interleave, localSource, makeSources, mergeRecalled, type Source } from "./sources.ts";
import { type FinishedRun, makeMemoryStore, type Note, type RecallCue } from "./store";

export type { EndedSession, FinishedRun, Found, Note, RecallCue, SearchQuery, SearchResult };
export { foundText };

/** What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as told. */
export interface Recalled {
  readonly ids: string[];
  readonly lines: string[];
}

export class Memory extends Context.Service<
  Memory,
  {
    readonly forAgent: (agent: string, session: string) => MemoryPort;
    readonly memoriesOf: (agent: string) => Effect.Effect<T.MemoryList>;
    readonly remember: (n: Note) => Effect.Effect<T.Memory, ApiError>;
    readonly forget: (agent: string, id: string) => Effect.Effect<void, ApiError>;
    /** What forget would do, refused as it would be; nothing changes. */
    readonly previewForget: (agent: string, id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly recallOf: (agent: string, project: string, text: string) => Effect.Effect<T.RecallPreview, ApiError>;
    /** What a run is told as it starts; only what is told is counted as recalled. */
    readonly recall: (cue: RecallCue) => Effect.Effect<Recalled>;
    /** Behind memory_search: every source's best, taken in turns, the same memory once. */
    readonly search: (q: SearchQuery) => Effect.Effect<SearchResult>;
    /** The local rows keep the run before this returns; the other sources get it in the background. */
    readonly keep: (run: FinishedRun) => Effect.Effect<void>;
    readonly endSession: (s: EndedSession) => Effect.Effect<void>;
    readonly write: (n: Note) => Effect.Effect<T.Memory, ApiError>;
    readonly list: (agent: string) => Effect.Effect<T.Memory[]>;
    readonly sources: Effect.Effect<T.MemorySourceInfo[]>;
    /** An orchestrator's archive: what its compactions folded away. */
    readonly archive: (agent: string, query: string) => Effect.Effect<T.ArchiveListing>;
    readonly archiveFile: (agent: string, name: string) => Effect.Effect<string | undefined>;
  }
>()("vibevalley/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.suspend(() => make()),
  );
}

/** Which outside source a configured one is; tests put their own. */
export type BuildSource = (c: Parameters<typeof nowledge>[0], http: HttpClient.HttpClient) => Source | undefined;

const defaultBuild: BuildSource = (c, http) => (c.kind === "nowledge" ? nowledge(c) : c.kind === "everos" ? everos(c, http) : undefined);

export const make = (build: BuildSource = defaultBuild, timeoutMs?: number) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const setting = yield* Setting;
    const agents = yield* Agent;
    const local = yield* makeMemoryStore;
    const http = yield* HttpClient.HttpClient;
    const sources = yield* makeSources({
      local: localSource(local, () => agents.agents().map((a) => a.id)),
      configured: setting.memorySources,
      build: (c) => build(c, http),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    // What an older cut left is cut again in the background.
    yield* Effect.forkScoped(Effect.andThen(loadSegmenter, local.recutTerms));
    const homeOf = (agent: string) => agentHome(config, agent);

    const list = Effect.fn("Memory.list")(function* (agent: string) {
      return (yield* sources.list(agent)).memories;
    });

    const write = Effect.fn("Memory.write")(function* (n: Note) {
      const kept = yield* local.write(n).pipe(Effect.mapError((e) => refused(e.message)));
      yield* sources.add(n);
      return kept;
    });

    const forget = (agent: string, id: string) => Effect.mapError(sources.forget(agent, id), (e) => refused(e.message));

    const preview = (agent: string, project: string, text: string) =>
      Effect.map(sources.prefetch({ agent, project, text, peek: true }), (groups): T.RecallPreview => {
        const lines = mergeRecalled(groups);
        return { lines: lines.map((l) => l.line), chars: lines.reduce((n, l) => n + l.line.length + 1, 0), limit: recallChars };
      });

    // forget and its dry run judge by this: the memory is there, and its source lets it be forgotten here.
    const forgettable = Effect.fn("Memory.forgettable")(function* (agent: string, id: string) {
      const problem = yield* sources.forgetProblem(id);
      if (problem) return yield* Effect.fail(refused(problem));
      const listed = yield* sources.list(agent);
      const m = listed.memories.find((x) => x.id === id);
      if (!m) return yield* Effect.fail(missing(t("server.memory.noMemory", { agent, id }), [memoriesOf(agent)]));
      return m;
    });

    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const shape = Memory.of({
      forAgent: (agent, session) => {
        const by = agents.isOrchestrator(agent) ? { kind: "orchestrator" as const, forOwner: false } : { kind: "session" as const, id: session };
        return {
          read: () =>
            runPromise(
              Effect.gen(function* () {
                const notes = (yield* local.list(agent)).filter((note) => note.kind === "note").toReversed();
                const lines = notes.map((note) => (note.author === "owner" ? fromOwner : "") + note.text);
                return { lines, prompt: carriedMemory(lines) };
              }),
            ),
          remember: (text) => runPromise(Effect.asVoid(local.write({ agent, text, project: "", by }))),
          rewrite: (text) =>
            runPromise(
              Effect.gen(function* () {
                const owners = new Set((yield* local.list(agent)).filter((note) => note.author === "owner").map((note) => note.text));
                const notes = parseMemoryLines(text)
                  .map((line) => line.text)
                  .filter((line) => !owners.has(line) && !(line.startsWith(fromOwner) && owners.has(line.slice(fromOwner.length).trim())));
                return yield* local.rewrite(agent, notes, by);
              }),
            ),
        };
      },
      memoriesOf: Effect.fn("Memory.memoriesOf")(function* (agent) {
        return yield* sources.list(agent);
      }),
      remember: Effect.fn("Memory.remember")(function* (n) {
        return yield* write(n);
      }),
      forget: Effect.fn("Memory.forget")(function* (agent, id) {
        yield* forgettable(agent, id);
        return yield* forget(agent, id);
      }),
      previewForget: Effect.fn("Memory.previewForget")(function* (agent, id) {
        const m = yield* forgettable(agent, id);
        return {
          does: [t("server.memory.forget", { agent, text: m.text })],
        };
      }),
      recallOf: Effect.fn("Memory.recallOf")(function* (agent, project, text) {
        return yield* preview(agent, project, text);
      }),
      recall: Effect.fn("Memory.recall")(function* (cue) {
        const told = mergeRecalled(yield* sources.prefetch(cue));
        const ids = told.map((l) => l.id).filter((id) => id !== "");
        yield* local.markRecalled(ids.filter((id) => !id.includes(":")));
        return { ids, lines: told.map((l) => l.line) };
      }),
      search: Effect.fn("Memory.search")(function* (q) {
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
      keep: Effect.fn("Memory.keep")(function* (r) {
        yield* local.keep(r);
        yield* sources.keep(r);
      }),
      endSession: Effect.fn("Memory.endSession")(function* (s) {
        yield* sources.endSession(s);
      }),
      write,
      list,
      sources: sources.info,
      archive: Effect.fn("Memory.archive")(function* (agent, query) {
        return {
          files: yield* Effect.promise(() => archiveFiles(homeOf(agent))),
          hits: query.trim() ? yield* Effect.promise(() => searchArchive(homeOf(agent), query)) : [],
        };
      }),
      archiveFile: Effect.fn("Memory.archiveFile")(function* (agent, name) {
        return yield* Effect.promise(() => readArchive(homeOf(agent), name));
      }),
    });
    return shape;
  });
