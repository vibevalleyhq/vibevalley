import { t } from "@vibevalley/i18n";
// This farm's own memories, rows in the memory table: what each agent noted (its
// 「记住：」 lines and the owner's notes) and one line for each job it did. A memory that cannot be read or written never
// stops a run: it is logged, and the run goes on without it.

import { sessionId } from "@vibevalley/protocol/schema";
import { type ActorKind, type Memory, MemoryKindValues, type Outcome } from "@vibevalley/protocol";
import type { Actor } from "../base/actor.ts";
import { Clock, Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Db } from "../base/db.ts";
import * as q from "../../db/generated/memory.sql.ts";
import { newId } from "../base/ids.ts";
import { clip, memoryIsNewNote, memoryJobText, memoryNotesOf, nextForgotten, noteMaxChars, pick, type PickCue } from "./recall.ts";
import { termsList, termsText, termsVersion } from "./terms.ts";

/** One finished run, everything about it; each provider keeps what it uses. */
export interface FinishedRun {
  readonly agent: string;
  readonly session: string;
  readonly project: string;
  readonly job: string;
  readonly outcome: Outcome;
  readonly said: string;
  readonly summary: string;
}

/** What a run recalls by. peek only questions: nothing is counted as recalled (the 记性 tab's preview). */
export interface RecallCue {
  readonly agent: string;
  readonly session?: string;
  readonly project: string;
  readonly text: string;
  readonly skip?: ReadonlySet<string>;
  readonly peek?: boolean;
}

/** A memory written outside a run: the owner's, from the 记性 tab, the orchestrator's for a profile, or a session's own. */
export interface Note {
  readonly agent: string;
  readonly text: string;
  readonly project: string;
  /** Who writes it: a session's note is kept with the session. */
  readonly by: Actor;
}

export class MemoryRefused extends Data.TaggedError("MemoryRefused")<{ readonly message: string }> {}

/** Fading marks the ones that would go if this many more were kept. */
const fadingSoon = 10;

const recutBatch = 100;

export const makeMemories = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const sql = yield* SqlClient.SqlClient;
  const { attempt: db } = yield* Db;

  const list = (agent: string) =>
    db(
      Effect.map(q.memoriesOf({ agent }), (rows) =>
        rows
          // A row of a kind this code does not know is left out.
          .filter((r) => (MemoryKindValues as readonly string[]).includes(r.kind))
          .map((r): Memory => ({
            id: r.id,
            agent,
            kind: r.kind as Memory["kind"],
            text: r.body,
            author: r.author as ActorKind,
            at: r.created_at,
            recalled: r.recalled,
            ...(r.project !== null ? { project: r.project } : {}),
            ...(r.session !== null ? { session: sessionId(r.session) } : {}),
            ...(r.recalled_at !== null ? { recalledAt: r.recalled_at } : {}),
          })),
      ),
    );

  const insertNote = Effect.fnUntraced(function* (agent: string, body: string, project: string | undefined, session: string | undefined, author: ActorKind) {
    const at = yield* Clock.currentTimeMillis;
    const id = newId();
    yield* db(
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
      const rows = yield* db(q.matchMemories({ words, agent }));
      return Object.fromEntries(rows.map((r) => [r.id, r.score ?? 0]));
    },
    (effect, agent) =>
      effect.pipe(Effect.catch((e) => Effect.as(Effect.logWarning(`searching ${agent}'s memories: ${String(e)}`), {} as Record<string, number>))),
  );

  /** What a run would recall; nothing is counted as recalled until markRecalled. */
  const recallable = Effect.fnUntraced(
    function* (cue: RecallCue) {
      const all = yield* list(cue.agent);
      const picked: PickCue = {
        session: cue.session,
        project: cue.project,
        text: cue.text,
        skip: cue.skip,
        now: yield* Clock.currentTimeMillis,
        matches: yield* matches(cue.agent, cue.text),
      };
      return pick(all, picked);
    },
    (effect, cue) => effect.pipe(Effect.catch((e) => Effect.as(Effect.logWarning(`${cue.agent} could not recall: ${String(e)}`), [] as Memory[]))),
  );

  const markRecalled = (ids: readonly string[]) =>
    Effect.forEach(ids, (id) => db(q.recalled({ recalled_at: clock.currentTimeMillisUnsafe(), id })), { discard: true }).pipe(
      Effect.catch((e) => Effect.logWarning(`a memory was recalled but not marked: ${String(e)}`)),
    );

  /** Reading for deduplication, keeping notes and pruning are one durable change. A stopped run leaves nothing. */
  const keep = (run: FinishedRun) =>
    run.outcome === "interrupted"
      ? Effect.void
      : sql
          .withTransaction(
            Effect.gen(function* () {
              let known = yield* list(run.agent);
              for (const note of memoryNotesOf(run.said)) {
                const project = note.everywhere ? undefined : run.project;
                if (!memoryIsNewNote(known, note.text, project)) continue;
                yield* insertNote(run.agent, note.text, project, run.session, "session");
                known = [...known, { kind: "note", text: note.text, project } as Memory];
              }
              const job = memoryJobText(run.job, run.summary, run.outcome);
              yield* db(
                q.keepJob({
                  id: newId(),
                  agent: run.agent,
                  body: job,
                  terms: termsText(job),
                  terms_of: termsVersion,
                  project: run.project,
                  session: run.session,
                  created_at: yield* Clock.currentTimeMillis,
                }),
              );
              for (const id of nextForgotten(yield* list(run.agent), 0)) yield* db(q.forget({ agent: run.agent, id }));
            }),
          )
          .pipe(Effect.catch((e) => Effect.logWarning(`what ${run.session} learned was not kept: ${String(e)}`)));

  const listed = Effect.fnUntraced(
    function* (agent: string) {
      const all = yield* list(agent);
      const fading = new Set(nextForgotten(all, fadingSoon));
      return all.map((m) => ({ ...m, fading: fading.has(m.id) }));
    },
    (effect, agent) => effect.pipe(Effect.catch((e) => Effect.as(Effect.logWarning(`memories of ${agent}: ${String(e)}`), [] as Memory[]))),
  );

  const write = Effect.fnUntraced(function* (n: Note) {
    const body = clip(n.text, noteMaxChars);
    if (body === "") return yield* new MemoryRefused({ message: t("server.memory.empty") });
    const project = n.project.trim() || undefined;
    const session = n.by.kind === "session" ? n.by.id || undefined : undefined;
    const { id, at } = yield* insertNote(n.agent, body, project, session, n.by.kind).pipe(
      Effect.catchTag("SqlError", (e) =>
        Effect.andThen(Effect.logWarning(`a note for ${n.agent}: ${String(e)}`), Effect.fail(new MemoryRefused({ message: t("server.memory.dbFailed") }))),
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
      ...(project ? { project } : {}),
      ...(session ? { session } : {}),
    } as Memory;
  });

  const forget = (agent: string, id: string) => db(q.forget({ agent, id })).pipe(Effect.orDie);

  /** Cuts again what an older termsVersion cut, a batch at a time: the terms are an index derived from the body. */
  const recutTerms = Effect.gen(function* () {
    for (;;) {
      const rows = yield* db(q.staleTerms({ version: termsVersion, n: recutBatch }));
      for (const r of rows) yield* db(q.setTerms({ terms: termsText(r.body), version: termsVersion, id: r.id }));
      if (rows.length < recutBatch) return;
    }
  }).pipe(Effect.catch((e) => Effect.logWarning(`memories were not cut again: ${String(e)}`)));

  return { list, listed, matches, recallable, markRecalled, keep, write, forget, recutTerms };
});

export type Memories = Effect.Success<typeof makeMemories>;
