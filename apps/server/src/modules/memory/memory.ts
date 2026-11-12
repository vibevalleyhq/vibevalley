import { agentFailed } from "@vibevalley/agent/core/errors";
import { archiveFiles, type MemoryPort, parseMemoryLines, readArchive, searchArchive } from "@vibevalley/agent/memory";
import { type Clock, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { type Actor, orchestrator, worker } from "#/base/actor.ts";
import { clip } from "#/base/clip.ts";
import { BizCode, bizError, memoriesOf, missing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { agentHome, type ServerConfig } from "#/infra/config.ts";
import { type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Setting } from "#/modules/setting/setting.ts";
import * as q from "#db/memory.sql.ts";

import { everos } from "./everos.ts";
import { loadSegmenter } from "./gse.ts";
import { nowledge } from "./nowledge.ts";
import { carriedMemory, fromUser } from "./prompts.ts";
import {
  foundText,
  type Found,
  inRepo,
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
import { type EndedSession, interleave, localSource, makeSources, mergeRecalled, type Source, type SourceDeps, SourceError } from "./sources.ts";

export type { EndedSession, Found, SearchQuery, SearchResult };
export { foundText };

/** What a run recalls: the memories' ids (not to give the same session again) and the lines it is told, as told. */
export interface Recalled {
  readonly ids: string[];
  readonly lines: string[];
}

export interface Memory {
  readonly forAgent: (agent: string, session: string) => MemoryPort;
  readonly memoriesOf: (agent: string) => Promise<T.MemoryList>;
  readonly remember: (n: Note) => Promise<T.Memory>;
  readonly forget: (agent: string, id: string) => Promise<void>;
  /** What forget would do, refused as it would be; nothing changes. */
  readonly previewForget: (agent: string, id: string) => Promise<T.Preview>;
  readonly recallOf: (agent: string, repo: string, text: string) => Promise<T.RecallPreview>;
  /** What a run is told as it starts; only what is told is counted as recalled. */
  readonly recall: (cue: RecallCue) => Promise<Recalled>;
  /** Behind memory_search: every source's best, taken in turns, the same memory once. */
  readonly search: (q: SearchQuery) => Promise<SearchResult>;
  /** The local rows keep the run before this returns; the other sources get it in the background. */
  readonly keep: (run: FinishedRun) => Promise<void>;
  readonly endSession: (s: EndedSession) => Promise<void>;
  readonly write: (n: Note) => Promise<T.Memory>;
  readonly list: (agent: string) => Promise<T.Memory[]>;
  readonly sources: () => Promise<T.MemorySourceInfo[]>;
  /** An orchestrator's archive: what its compactions folded away. */
  readonly archive: (agent: string, query: string) => Promise<T.ArchiveListing>;
  readonly archiveFile: (agent: string, name: string) => Promise<string | undefined>;
  /** Stops cutting terms again, then drains and stops the memory sources. */
  readonly close: () => Promise<void>;
}

export interface MemoryDeps {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly db: Db;
  readonly setting: Setting;
  readonly agent: Agent;
}

/** Which outside source a configured one is; tests put their own. */
export type BuildSource = (c: Parameters<typeof nowledge>[0], deps: SourceDeps) => Source | undefined;

const defaultBuild: BuildSource = (c, deps) => (c.kind === "nowledge" ? nowledge(c, deps) : c.kind === "everos" ? everos(c, deps) : undefined);

export interface MemoryOptions {
  readonly build?: BuildSource;
  /** How long a read waits on a source outside the farm. */
  readonly timeoutMs?: number;
}

export async function makeMemory(deps: MemoryDeps, options: MemoryOptions = {}): Promise<Memory> {
  const { config, setting, agent: agents } = deps;
  const build = options.build ?? defaultBuild;
  const log = deps.log.child("memory");
  const local = makeMemoryStore({ clock: deps.clock, db: deps.db, log });
  const sourceDeps: SourceDeps = { fetch: deps.fetch, clock: deps.clock, log };
  const sources = makeSources({
    local: localSource(local, () => agents.agents().map((a) => a.id), deps.clock),
    configured: setting.memorySources,
    build: (c) => build(c, sourceDeps),
    clock: deps.clock,
    log,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const tasks = new TaskGroup({ name: "memory", onError: (task, e) => log.error(`${task} failed`, e) });
  // What an older cut left is cut again in the background.
  tasks.run("recut terms", async (signal) => {
    await loadSegmenter();
    await local.recutTerms(signal);
  });
  const homeOf = (agent: string) => agentHome(config, agent);

  const list = async (agent: string) => (await sources.list(agent)).memories;

  const write = async (n: Note) => {
    const kept = await local.write(n);
    await sources.add(n);
    return kept;
  };

  const forget = async (agent: string, id: string) => {
    try {
      await sources.forget(agent, id);
    } catch (e) {
      if (e instanceof SourceError) throw bizError(BizCode.MemoryRefused, e.message);
      throw e;
    }
  };

  const preview = async (agent: string, repo: string, text: string): Promise<T.RecallPreview> => {
    const lines = mergeRecalled(await sources.prefetch({ agent, repo, text, peek: true }));
    return { lines: lines.map((l) => l.line), chars: lines.reduce((n, l) => n + l.line.length + 1, 0), limit: recallChars };
  };

  // forget and its dry run judge by this: the memory is there, and its source lets it be forgotten here.
  const forgettable = async (agent: string, id: string) => {
    const problem = await sources.forgetProblem(id);
    if (problem) throw bizError(BizCode.MemoryRefused, problem);
    const listed = await sources.list(agent);
    const m = listed.memories.find((x) => x.id === id);
    if (!m) throw missing(t("server.memory.noMemory", { agent, id }), [memoriesOf(agent)]);
    return m;
  };

  /** An archive read that fails is logged and read as fallback. */
  const orElse = async <A>(what: string, read: () => Promise<A>, fallback: A): Promise<A> => {
    try {
      return await read();
    } catch (e) {
      log.warn(`${what}: ${String(e)}`);
      return fallback;
    }
  };

  return {
    forAgent: (agent, session) => {
      const by = agents.isOrchestrator(agent) ? orchestrator(false) : worker(session);
      return {
        read: async () => {
          const all = await local.list(agent).catch((e: unknown): T.Memory[] => {
            if (!(e instanceof SqlError)) throw e;
            log.warn(`memory of ${agent} could not be read: ${String(e)}`);
            return [];
          });
          const notes = all.filter((note) => note.kind === "note").toReversed();
          const lines = notes.map((note) => (note.author === "user" ? fromUser : "") + note.text);
          return { lines, prompt: carriedMemory(lines) };
        },
        remember: async (text) => {
          try {
            await local.write({ agent, text, repo: "", by });
          } catch (e) {
            throw agentFailed(e);
          }
        },
        rewrite: async (text) => {
          try {
            const users = new Set((await local.list(agent)).filter((note) => note.author === "user").map((note) => note.text));
            const notes = parseMemoryLines(text)
              .map((line) => line.text)
              .filter((line) => !users.has(line) && !(line.startsWith(fromUser) && users.has(line.slice(fromUser.length).trim())));
            return await local.rewrite(agent, notes, by);
          } catch (e) {
            throw agentFailed(e);
          }
        },
      };
    },
    memoriesOf: (agent) => sources.list(agent),
    remember: (n) => write(n),
    forget: async (agent, id) => {
      await forgettable(agent, id);
      await forget(agent, id);
    },
    previewForget: async (agent, id) => {
      const m = await forgettable(agent, id);
      return {
        does: [t("server.memory.forget", { agent, text: m.text })],
      };
    },
    recallOf: (agent, repo, text) => preview(agent, repo, text),
    recall: async (cue) => {
      const told = mergeRecalled(await sources.prefetch(cue));
      const ids = told.map((l) => l.id).filter((id) => id !== "");
      await local.markRecalled(ids.filter((id) => !id.includes(":")));
      return { ids, lines: told.map((l) => l.line) };
    },
    search: async (q) => {
      const query = { ...q, limit: q.limit > 0 ? q.limit : searchLimit };
      const pages = await sources.search(query);
      const coverage = pages.flatMap((page) => {
        const notes = page.coverage ? [page.coverage] : [];
        if (query.repo && page.found.some((f) => f.scope.kind === "unknown")) notes.push(t("server.memory.coverage.unconfirmed"));
        return notes.map((note) => t("server.memory.coverage.note", { source: sourceLabel(page.source), note }));
      });
      const found = interleave(
        pages.map((page) => page.found),
        (f) => f.text,
        (f) => inRepo(f.scope, query.repo),
      ).slice(0, query.limit);
      return { found, coverage };
    },
    keep: async (r) => {
      await local.keep(r);
      await sources.keep(r);
    },
    endSession: (s) => sources.endSession(s),
    write,
    list,
    sources: () => sources.info(),
    archive: async (agent, query) => {
      const home = homeOf(agent);
      const files = await orElse(`archive of ${agent} could not be listed`, () => archiveFiles(home), []);
      const hits = query.trim() ? await orElse(`archive of ${agent} could not be searched`, () => searchArchive(home, query, 0), []) : [];
      return { files, hits };
    },
    archiveFile: (agent, name) => orElse(`archive file ${name} of ${agent} could not be read`, () => readArchive(homeOf(agent), name), undefined),
    close: async () => {
      await tasks.close();
      await sources.close();
    },
  };
}

// This farm's own memories, rows in the memory table.

/** One finished run, everything about it; each provider keeps what it uses. */
export interface FinishedRun {
  readonly agent: string;
  readonly session: string;
  readonly issue?: string;
  readonly repo: string;
  readonly brief: string;
  readonly outcome: T.Outcome;
  readonly said: string;
  readonly summary: string;
}

/** What a run recalls by. peek only questions: nothing is counted as recalled (the Memory tab's preview). */
export interface RecallCue {
  readonly agent: string;
  readonly session?: string;
  readonly repo: string;
  readonly text: string;
  readonly skip?: ReadonlySet<string>;
  readonly peek?: boolean;
}

/** A memory written outside a run: the user's, from the Memory tab, the orchestrator's for a profile, or a session's own. */
export interface Note {
  readonly agent: string;
  readonly text: string;
  readonly repo: string;
  /** Who writes it: a session's note is kept with the session. */
  readonly by: Actor;
}

/** Fading marks the ones that would go if this many more were kept. */
const fadingSoon = 10;

const recutBatch = 100;

/** A read whose failed query is logged and taken as none (infra/db.test.ts lists this file). */
const orNone =
  <B>(log: Logger, what: string, none: B) =>
  (e: unknown): B => {
    if (!(e instanceof SqlError)) throw e;
    log.warn(`${what}: ${String(e)}`);
    return none;
  };

function makeMemoryStore(deps: { readonly clock: Clock; readonly db: Db; readonly log: Logger }) {
  const { clock, db, log } = deps;

  const list = async (agent: string) =>
    (await q.memoriesOf(db.sql, { agent })).map((r): T.Memory => ({
      id: r.id,
      agent,
      kind: r.kind,
      text: r.body,
      author: r.author,
      at: r.created_at,
      recalled: r.recalled,
      fading: false,
      ...(r.repo !== null ? { repo: r.repo } : {}),
      ...(r.session !== null ? { session: sessionId(r.session) } : {}),
      ...(r.recalled_at !== null ? { recalledAt: r.recalled_at } : {}),
    }));

  const insertNote = async (agent: string, body: string, repo: string | undefined, session: string | undefined, author: T.ActorKind) => {
    const at = clock.now();
    const id = newId();
    await q.addNote(db.sql, {
      id,
      agent,
      body,
      terms: termsText(body),
      terms_of: termsVersion,
      repo: repo ?? null,
      session: session ?? null,
      author,
      created_at: at,
    });
    return { id, at };
  };

  /** Every agent memory sharing any of text's words, how well (higher better); none when the index cannot say. */
  const matches = async (agent: string, text: string): Promise<Record<string, number>> => {
    const words = termsList(text);
    if (words.length === 0) return {};
    try {
      const rows = await q.matchMemories(db.sql, { words, agent });
      return Object.fromEntries(rows.map((r) => [r.id, r.score]));
    } catch (e) {
      return orNone(log, `searching ${agent}'s memories`, {})(e);
    }
  };

  /** What a run would recall; nothing is counted as recalled until markRecalled. */
  const recallable = async (cue: RecallCue): Promise<T.Memory[]> => {
    try {
      const all = await list(cue.agent);
      const picked: PickCue = omitUndefined({
        session: cue.session,
        repo: cue.repo,
        text: cue.text,
        skip: cue.skip,
        now: clock.now(),
        matches: await matches(cue.agent, cue.text),
      });
      return pick(all, picked);
    } catch (e) {
      return orNone(log, `${cue.agent} could not recall`, [])(e);
    }
  };

  const markRecalled = (ids: readonly string[]) =>
    bestEffort(log, "a memory was recalled but not marked", async () => {
      for (const id of ids) await q.recalled(db.sql, { recalled_at: clock.now(), id });
    });

  /** Reading for deduplication, keeping notes and pruning are one durable change. A stopped run leaves nothing. */
  const keep = async (run: FinishedRun) => {
    if (run.outcome === "interrupted") return;
    await bestEffort(log, `what ${run.session} learned was not kept`, () =>
      db.tx(async () => {
        if (run.issue) {
          const text = issueMemoryText(run.brief, run.summary, run.outcome);
          await q.keepIssueMemory(db.sql, {
            id: newId(),
            agent: run.agent,
            body: text,
            terms: termsText(text),
            terms_of: termsVersion,
            repo: run.repo,
            session: run.session,
            created_at: clock.now(),
          });
        }
        const found = await list(run.agent);
        for (const id of nextForgotten(found, 0)) await q.forget(db.sql, { agent: run.agent, id });
      }),
    );
  };

  const listed = async (agent: string): Promise<T.Memory[]> => {
    try {
      const all = await list(agent);
      const fading = new Set(nextForgotten(all, fadingSoon));
      return all.map((m) => ({ ...m, fading: fading.has(m.id) }));
    } catch (e) {
      return orNone(log, `memories of ${agent}`, [])(e);
    }
  };

  const write = async (n: Note): Promise<T.Memory> => {
    const body = clip(n.text, noteMaxChars);
    if (body === "") throw bizError(BizCode.MemoryRefused, t("server.memory.empty"));
    const repo = n.repo.trim() || undefined;
    const session = n.by.kind === "agent" && n.by.role === "worker" ? n.by.id || undefined : undefined;
    let kept: { id: string; at: number };
    try {
      kept = await insertNote(n.agent, body, repo, session, n.by.kind);
    } catch (e) {
      if (!(e instanceof SqlError)) throw e;
      log.warn(`a note for ${n.agent}: ${String(e)}`);
      throw bizError(BizCode.MemoryRefused, t("server.memory.dbFailed"));
    }
    return {
      id: kept.id,
      agent: n.agent,
      kind: "note",
      text: body,
      author: n.by.kind,
      at: kept.at,
      recalled: 0,
      fading: false,
      ...(repo ? { repo } : {}),
      ...(session ? { session: sessionId(session) } : {}),
    } satisfies T.Memory;
  };

  const forget = async (agent: string, id: string) => {
    await q.forget(db.sql, { agent, id });
  };

  const rewrite = (agent: string, texts: readonly string[], by: Actor) =>
    db.tx(async () => {
      await q.clearManagedNotes(db.sql, { agent });
      for (const text of texts) await write({ agent, text, repo: "", by });
      return texts.length;
    });

  /** Cuts again what an older termsVersion cut, a batch at a time: the terms are an index derived from the body. */
  const recutTerms = (signal: AbortSignal) =>
    bestEffort(
      log,
      "memories were not cut again",
      async () => {
        for (;;) {
          signal.throwIfAborted();
          const rows = await q.staleTerms(db.sql, { version: termsVersion, n: recutBatch });
          for (const r of rows) await q.setTerms(db.sql, { terms: termsText(r.body), version: termsVersion, id: r.id });
          if (rows.length < recutBatch) return;
        }
      },
      signal,
    );

  return { list, listed, matches, recallable, markRecalled, keep, write, rewrite, forget, recutTerms };
}

export type MemoryStore = ReturnType<typeof makeMemoryStore>;
