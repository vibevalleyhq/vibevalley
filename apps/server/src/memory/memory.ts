import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";

import { archiveFiles, type MemoryPort, parseMemoryLines, readArchive, searchArchive } from "@vibevalley/agent/memory";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import type { Actor } from "#/base/actor.ts";
import { clip } from "#/base/clip.ts";
import { newId } from "#/base/ids.ts";
import { type ApiError, memoriesOf, missing, refused } from "#/errors.ts";
import { agentHome, ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Setting } from "#/setting/setting.ts";
import * as q from "#db/memory.sql.ts";

import { everos } from "./everos.ts";
import { loadSegmenter } from "./gse.ts";
import { nowledge } from "./nowledge.ts";
import { carriedMemory, fromOwner } from "./prompts.ts";
import {
  foundText,
  type Found,
  inProject,
  issueMemoryText,
  nextForgotten,
  noteMaxChars,
  pick,
  type PickCue,
  recallChars,
  searchLimit,
  type SearchQuery,
  type SearchResult,
  sourceLabel,
  termsList,
  termsText,
  termsVersion,
} from "./recall.ts";
import { type EndedSession, interleave, localSource, makeSources, mergeRecalled, type Source } from "./sources.ts";

export type { EndedSession, Found, SearchQuery, SearchResult };
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

    const shape = Memory.of({
      forAgent: (agent, session) => {
        const by = agents.isOrchestrator(agent) ? { kind: "orchestrator" as const, forOwner: false } : { kind: "session" as const, id: session };
        return {
          read: () =>
            Effect.map(local.list(agent), (all) => {
              const notes = all.filter((note) => note.kind === "note").toReversed();
              const lines = notes.map((note) => (note.author === "owner" ? fromOwner : "") + note.text);
              return { lines, prompt: carriedMemory(lines) };
            }),
          remember: (text) => Effect.asVoid(local.write({ agent, text, project: "", by })),
          rewrite: (text) =>
            Effect.gen(function* () {
              const owners = new Set((yield* local.list(agent)).filter((note) => note.author === "owner").map((note) => note.text));
              const notes = parseMemoryLines(text)
                .map((line) => line.text)
                .filter((line) => !owners.has(line) && !(line.startsWith(fromOwner) && owners.has(line.slice(fromOwner.length).trim())));
              return yield* local.rewrite(agent, notes, by);
            }),
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

// This farm's own memories, rows in the memory table.

/** One finished run, everything about it; each provider keeps what it uses. */
export interface FinishedRun {
  readonly agent: string;
  readonly session: string;
  readonly issue?: string;
  readonly project: string;
  readonly brief: string;
  readonly outcome: T.Outcome;
  readonly said: string;
  readonly summary: string;
}

/** What a run recalls by. peek only questions: nothing is counted as recalled (the Memory tab's preview). */
export interface RecallCue {
  readonly agent: string;
  readonly session?: string;
  readonly project: string;
  readonly text: string;
  readonly skip?: ReadonlySet<string>;
  readonly peek?: boolean;
}

/** A memory written outside a run: the owner's, from the Memory tab, the orchestrator's for a profile, or a session's own. */
export interface Note {
  readonly agent: string;
  readonly text: string;
  readonly project: string;
  /** Who writes it: a session's note is kept with the session. */
  readonly by: Actor;
}

class MemoryRefused extends Schema.TaggedError<MemoryRefused, { readonly brand: unique symbol }>()("MemoryRefused", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Fading marks the ones that would go if this many more were kept. */
const fadingSoon = 10;

const recutBatch = 100;

const makeMemoryStore = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const db = yield* Db;

  const list = (agent: string) =>
    db.attempt(
      Effect.map(q.memoriesOf({ agent }), (rows) =>
        rows.map((r): T.Memory => ({
          id: r.id,
          agent,
          kind: r.kind,
          text: r.body,
          author: r.author,
          at: r.created_at,
          recalled: r.recalled,
          fading: false,
          ...(r.project !== null ? { project: r.project } : {}),
          ...(r.session !== null ? { session: sessionId(r.session) } : {}),
          ...(r.recalled_at !== null ? { recalledAt: r.recalled_at } : {}),
        })),
      ),
    );

  const insertNote = Effect.fnUntraced(function* (agent: string, body: string, project: string | undefined, session: string | undefined, author: T.ActorKind) {
    const at = yield* Clock.currentTimeMillis;
    const id = newId();
    yield* db.attempt(
      q.addNote({
        id,
        agent,
        body,
        terms: termsText(body),
        terms_of: termsVersion,
        project: project ?? null,
        session: session ?? null,
        author,
        created_at: at,
      }),
    );
    return { id, at };
  });

  /** Every agent memory sharing any of text's words, how well (higher better); none when the index cannot say. */
  const matches = Effect.fnUntraced(
    function* (agent: string, text: string) {
      const words = termsList(text);
      if (words.length === 0) return {};
      const rows = yield* db.attempt(q.matchMemories({ words, agent }));
      return Object.fromEntries(rows.map((r) => [r.id, r.score ?? 0]));
    },
    (effect, agent) =>
      effect.pipe(Effect.catch((e) => Effect.as<Record<string, number>>(Effect.logWarning(`searching ${agent}'s memories: ${String(e)}`), {}))),
  );

  /** What a run would recall; nothing is counted as recalled until markRecalled. */
  const recallable = Effect.fnUntraced(
    function* (cue: RecallCue) {
      const all = yield* list(cue.agent);
      const picked: PickCue = omitUndefined({
        session: cue.session,
        project: cue.project,
        text: cue.text,
        skip: cue.skip,
        now: yield* Clock.currentTimeMillis,
        matches: yield* matches(cue.agent, cue.text),
      });
      return pick(all, picked);
    },
    (effect, cue) => effect.pipe(Effect.catch((e) => Effect.as<T.Memory[]>(Effect.logWarning(`${cue.agent} could not recall: ${String(e)}`), []))),
  );

  const markRecalled = (ids: readonly string[]) =>
    Effect.forEach(ids, (id) => db.attempt(q.recalled({ recalled_at: clock.currentTimeMillisUnsafe(), id })), { discard: true }).pipe(
      bestEffort("a memory was recalled but not marked"),
    );

  /** Reading for deduplication, keeping notes and pruning are one durable change. A stopped run leaves nothing. */
  const keep = (run: FinishedRun) =>
    run.outcome === "interrupted"
      ? Effect.void
      : db
          .attemptTx(
            Effect.gen(function* () {
              if (run.issue) {
                const text = issueMemoryText(run.brief, run.summary, run.outcome);
                yield* db.attempt(
                  q.keepIssueMemory({
                    id: newId(),
                    agent: run.agent,
                    body: text,
                    terms: termsText(text),
                    terms_of: termsVersion,
                    project: run.project,
                    session: run.session,
                    created_at: yield* Clock.currentTimeMillis,
                  }),
                );
              }
              yield* Effect.forEach(nextForgotten(yield* list(run.agent), 0), (id) => db.attempt(q.forget({ agent: run.agent, id })), { discard: true });
            }),
          )
          .pipe(bestEffort(`what ${run.session} learned was not kept`));

  const listed = Effect.fnUntraced(
    function* (agent: string) {
      const all = yield* list(agent);
      const fading = new Set(nextForgotten(all, fadingSoon));
      return all.map((m) => ({ ...m, fading: fading.has(m.id) }));
    },
    (effect, agent) => effect.pipe(Effect.catch((e) => Effect.as<T.Memory[]>(Effect.logWarning(`memories of ${agent}: ${String(e)}`), []))),
  );

  const write = Effect.fnUntraced(function* (n: Note) {
    const body = clip(n.text, noteMaxChars);
    if (body === "") return yield* new MemoryRefused({ message: t("server.memory.empty") });
    const project = n.project.trim() || undefined;
    const session = n.by.kind === "session" ? n.by.id || undefined : undefined;
    const { id, at } = yield* insertNote(n.agent, body, project, session, n.by.kind).pipe(
      Effect.catchTag("SqlError", (e) =>
        Effect.andThen(
          Effect.logWarning(`a note for ${n.agent}: ${String(e)}`),
          Effect.fail(new MemoryRefused({ message: t("server.memory.dbFailed"), cause: e })),
        ),
      ),
    );
    return {
      id,
      agent: n.agent,
      kind: "note",
      text: body,
      author: n.by.kind,
      at,
      recalled: 0,
      fading: false,
      ...(project ? { project } : {}),
      ...(session ? { session: sessionId(session) } : {}),
    } satisfies T.Memory;
  });

  const forget = (agent: string, id: string) => db.run(q.forget({ agent, id }));

  const rewrite = (agent: string, texts: readonly string[], by: Actor) =>
    db.attemptTx(
      Effect.gen(function* () {
        yield* q.clearManagedNotes({ agent });
        yield* Effect.forEach(texts, (text) => write({ agent, text, project: "", by }), { discard: true });
        return texts.length;
      }),
    );

  /** Cuts again what an older termsVersion cut, a batch at a time: the terms are an index derived from the body. */
  const recutTerms = Effect.gen(function* () {
    for (;;) {
      const rows = yield* db.attempt(q.staleTerms({ version: termsVersion, n: recutBatch }));
      yield* Effect.forEach(rows, (r) => db.attempt(q.setTerms({ terms: termsText(r.body), version: termsVersion, id: r.id })), { discard: true });
      if (rows.length < recutBatch) return;
    }
  }).pipe(bestEffort("memories were not cut again"));

  return { list, listed, matches, recallable, markRecalled, keep, write, rewrite, forget, recutTerms };
});

export type MemoryStore = Effect.Success<typeof makeMemoryStore>;
