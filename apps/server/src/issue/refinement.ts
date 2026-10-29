import { t } from "@vibevalley/i18n";
import { draftMatch, refinementBrief } from "./prompts.ts";
import type { Agent, Question, Issue } from "@vibevalley/protocol";
import { Effect, Semaphore, Predicate } from "effect";
import type { SqlClient } from "effect/sql";
import type { Agents } from "@/agent/agent.ts";
import { cut, clip } from "@/base/clip.ts";
import type { Channels } from "@/channel/chat.ts";
import type { Core } from "@/core/core.ts";
import { type ApiError, refused, lookIn, messageOf } from "@/errors.ts";
import type { WorkplaceRelease } from "@/project/shapes.ts";
import { chooseAgent } from "@/runtime/fit.ts";
import type { Runtimes } from "@/runtime/runtime.ts";
import type { Hired, HireOptions, Sessions } from "@/session/session.ts";
import { isForOrchestrator } from "./status.ts";
import { jsonOrNull, nullText } from "./stored.ts";
import { splitBrief } from "./brief.ts";

import * as q from "../../db/generated/issue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";

export interface RefinementDeps {
  readonly core: Core["Service"];
  readonly store: Agents["Service"];
  readonly runtimes: Runtimes["Service"];
  readonly sessions: Sessions["Service"];
  readonly chat: Channels["Service"];
  readonly db: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
  readonly one: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A | undefined>;
  readonly inTx: <A, E>(e: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
  readonly get: (ref: string) => Effect.Effect<Issue, ApiError>;
  /** The issue while it was never sent (no task graph's). */
  readonly unsent: (id: string) => Effect.Effect<Issue, ApiError>;
  readonly hire: (agent: Agent, task: string, project: string, opt?: HireOptions) => Effect.Effect<Hired, ApiError>;
  readonly publish: (id: string) => Effect.Effect<void>;
}

export function refinement(d: RefinementDeps) {
  const { core, store, runtimes, sessions, chat, db, one, inTx, get, unsent, hire, publish } = d;
  /** One draft starts at a time: two clicks do not send two sessions. */
  const drafting = Semaphore.makeUnsafe(1);

  /** Who drafts: its assignee; else whoever was last sent to work in its project, if they can work now; else chooseAgent. */
  const refiner = Effect.fnUntraced(function* (issue: Issue) {
    const candidates = yield* runtimes.candidates;
    let named = "";
    if (issue.assignee) {
      if (!store.agent(issue.assignee)) return yield* Effect.fail(refused(t("server.issue.profileGone", { id: issue.assignee })));
      named = issue.assignee;
    } else if (issue.project) {
      const last = (yield* one(qs.lastAssigneeIn({ project: issue.project })))?.assignee;
      if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
    }
    const chosen = chooseAgent(candidates, draftMatch(issue.title), named, "");
    if (!chosen) return yield* Effect.fail(refused(t("server.issue.refinement.noDrafter"), [lookIn.agent]));
    return chosen;
  });

  const beforeRefinement = Effect.fnUntraced(function* (issue: Issue, word: string, agent: string, where: string) {
    let [title, description] = [issue.title, issue.description];
    if (word && issue.questions.length === 0 && !description && issue.criteria.length === 0) [title, description] = splitBrief(word);
    yield* inTx(
      Effect.gen(function* () {
        yield* db(
          q.editIssue({
            title,
            description,
            project: nullText(issue.project ?? where),
            assignee: nullText(issue.assignee ?? agent),
            priority: issue.priority,
            criteria: jsonOrNull(issue.criteria, issue.criteria.length > 0),
            deliver: issue.deliver,
            id: issue.id,
          }),
        );
        if (word && issue.questions.length > 0) yield* db(q.setIssueQuestions({ id: issue.id, questions: null }));
      }),
    );
    yield* publish(issue.id);
  });

  const refined = Effect.fnUntraced(function* (id: string, d: IssueRefinement, questions: readonly Question[] | undefined) {
    const criteria = kept(d.criteria);
    const open = openQuestions(questions);
    yield* db(
      q.refineIssue({
        id,
        title: d.title,
        description: refinementDescription(d),
        criteria: jsonOrNull(criteria, criteria.length > 0),
        questions: jsonOrNull(open, open.length > 0),
      }),
    );
    yield* publish(id);
  });

  const draft = Effect.fn("Issues.draft")(
    function* (id: string, word: string, channel: string) {
      const item = yield* unsent(id);
      if (isForOrchestrator(item, store.isOrchestrator)) return yield* Effect.fail(refused(t("server.issue.refinement.orchestrator")));
      if (item.status !== "backlog") return yield* Effect.fail(refused(t("server.issue.refinement.onlyBacklog")));
      if (item.refining) return yield* Effect.fail(refused(t("server.issue.refinement.drafting", { name: item.refining.name })));
      const chosen = yield* refiner(item);
      const where = item.project ?? chosen.workdir.trim();
      if (!where) return yield* Effect.fail(refused(t("server.issue.refinement.noProject")));
      const said = word.trim();
      const brief = refinementBrief(item, said, where);
      yield* beforeRefinement(item, said, chosen.id, where);
      // A draft cut short (a restart) may have left the worktree as its refiner had it: each draft starts from main.
      const kept = yield* sessions.clearWorkplace(item.id, where, item.number);
      if (kept.kept) yield* Effect.logInfo(`vibevalley: issue ${item.id}: before its draft: ${kept.reason}`);
      // Always a worktree, even for a profile that works in the project folder: the reset after it must not touch the owner's checkout.
      const hired = yield* hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "refine" }, refining: true });
      if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")));
      // Its moves no longer hold todo while it drafts.
      yield* publish(id);
      return yield* get(id);
    },
    (effect) => drafting.withPermits(1)(effect),
  );

  const handedBack = Effect.fn("Issues.handedBack")(function* (f: { id: string; outcome: string; summary: string; questions?: readonly Question[] }) {
    const h = sessions.sessionOf(f.id);
    if (!h?.refining || !h.issue) return;
    const id = h.issue;
    const r = sessions.find(f.id);
    const said = r?.lastText ?? "";
    const thread = yield* chat.jobThread(f.id);
    const tell = (text: string) => (thread ? chat.notice(thread, text, "issue_refinement") : core.notice("warn", text));
    if (f.outcome === "completed") {
      const { draft: d, problem } = parseRefinement(said);
      if (!d) yield* tell(t("server.issue.refinement.unread", { name: h.name, problem }));
      else yield* refined(id, d, f.questions);
    } else yield* tell(t("server.issue.refinement.unfinished", { name: h.name, summary: f.summary }));
    yield* sessions.dismiss(f.id, "discard");
    yield* publish(id);
  });

  const clearRefinement = Effect.fn("Issues.clearRefinement")(function* (issue: Issue): Effect.fn.Return<WorkplaceRelease, ApiError> {
    if (issue.refining) yield* sessions.dismiss(issue.refining.session, "discard");
    if (issue.project) {
      const kept = yield* sessions.clearWorkplace(issue.id, issue.project, issue.number);
      if (kept.kept) yield* core.notice("warn", t("server.issue.refinement.canceled", { title: cut(issue.title, 40), why: kept.reason }));
      return kept;
    }
    return { kept: false };
  });

  return { draft, handedBack, clearRefinement };
}

/** A list may come as one string. */
export interface IssueRefinement {
  readonly title: string;
  readonly why: string;
  readonly todo: string[];
  readonly criteria: string[];
  readonly notDoing: string[];
  readonly files: string[];
}

export const kept = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== "");

export const openQuestions = (questions: readonly Question[] | undefined): Question[] => (questions ?? []).filter((a) => a.question.trim() !== "");

function linesOf(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw new Error(t("server.issue.refinement.lines", { field }));
}

function textOf(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  throw new Error(t("server.issue.refinement.text", { field }));
}

const refinementBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** The last block that reads as a draft with a title; problem says why none did. */
export function parseRefinement(text: string): { draft?: IssueRefinement; problem: string } {
  const blocks = [...text.matchAll(refinementBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: t("server.issue.refinement.noBlock") };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let d: IssueRefinement;
    try {
      const raw: unknown = JSON.parse(blocks[i]!);
      if (!Predicate.isObject(raw)) throw new Error(t("server.issue.refinement.notObject"));
      d = {
        title: textOf(raw.title, "title"),
        why: textOf(raw.why, "why"),
        todo: linesOf(raw.todo, "todo"),
        criteria: linesOf(raw.criteria, "criteria"),
        notDoing: linesOf(raw.notDoing, "notDoing"),
        files: linesOf(raw.files, "files"),
      };
    } catch (e) {
      problem = t("server.issue.refinement.unreadable", { why: messageOf(e) });
      continue;
    }
    const title = clip(d.title, 80);
    if (!title) {
      problem = t("server.issue.refinement.noTitle");
      continue;
    }
    return { draft: { ...d, title }, problem: "" };
  }
  return { problem };
}

export function refinementDescription(d: IssueRefinement): string {
  const parts: string[] = [];
  const why = d.why.trim();
  if (why) parts.push(t("server.issue.refinement.why") + "\n" + why);
  for (const [head, lines] of [
    [t("server.issue.refinement.todo"), kept(d.todo)],
    [t("server.issue.refinement.notDoing"), kept(d.notDoing)],
    [t("server.issue.refinement.files"), kept(d.files)],
  ] as const)
    if (lines.length > 0) parts.push(head + "\n- " + lines.join("\n- "));
  return parts.join("\n\n");
}
