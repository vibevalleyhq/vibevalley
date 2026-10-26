import { issueWording } from "./words.ts";
import { draftMatch, refinementBrief } from "./prompts.ts";
import type { Agent, Question, Issue } from "@vibevalley/protocol";
import { Effect, Semaphore } from "effect";
import type { SqlClient } from "effect/sql";
import * as q from "../../db/generated/issue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";
import type { AgentShape } from "../agent/agent.ts";
import { cut } from "../base/text.ts";
import type { ChannelShape } from "../channel/chat.ts";
import type { CoreShape } from "../core/core.ts";
import { type ApiError, refused, lookIn } from "../errors.ts";
import type { WorkplaceRelease } from "../project/shapes.ts";
import { chooseAgent } from "../runtime/rules.ts";
import type { RuntimeShape } from "../runtime/runtime.ts";
import type { Hired, HireOptions, SessionShape } from "../session/session.ts";
import { isForOrchestrator } from "./state.ts";
import { refinementDescription, type IssueRefinement, jsonOrNull, kept, nullText, openQuestions, parseRefinement, splitJob } from "./rules.ts";

export interface RefinementDeps {
  readonly core: CoreShape;
  readonly store: AgentShape;
  readonly runtimes: RuntimeShape;
  readonly sessions: SessionShape;
  readonly chat: ChannelShape;
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
  const refiner = Effect.fnUntraced(function* (t: Issue) {
    const candidates = yield* runtimes.candidates;
    let named = "";
    if (t.assignee) {
      if (!store.agent(t.assignee)) return yield* Effect.fail(refused(issueWording().profileGone(t.assignee)));
      named = t.assignee;
    } else if (t.project) {
      const last = (yield* one(qs.lastAssigneeIn({ project: t.project })))?.assignee;
      if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
    }
    const chosen = chooseAgent(candidates, draftMatch(t.title), named, "");
    if (!chosen) return yield* Effect.fail(refused(issueWording().draft.noDrafter, [lookIn.agent]));
    return chosen;
  });

  const beforeRefinement = Effect.fnUntraced(function* (t: Issue, word: string, agent: string, where: string) {
    let [title, description] = [t.title, t.description ?? ""];
    if (word && t.questions.length === 0 && !description && (t.criteria ?? []).length === 0) [title, description] = splitJob(word);
    yield* inTx(
      Effect.gen(function* () {
        yield* db(
          q.editIssue({
            title,
            description,
            project: nullText(t.project ?? where),
            assignee: nullText(t.assignee ?? agent),
            priority: t.priority,
            review: t.review,
            criteria: jsonOrNull(t.criteria, (t.criteria ?? []).length > 0),
            deliver: t.deliver,
            id: t.id,
          }),
        );
        if (word && t.questions.length > 0) yield* db(q.setIssueQuestions({ id: t.id, questions: null }));
      }),
    );
    yield* publish(t.id);
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
      const t = yield* unsent(id);
      if (isForOrchestrator(t)) return yield* Effect.fail(refused(issueWording().draft.orchestrator));
      if (t.status !== "backlog") return yield* Effect.fail(refused(issueWording().draft.onlyBacklog));
      if (t.refining) return yield* Effect.fail(refused(issueWording().draft.drafting(t.refining.name)));
      const chosen = yield* refiner(t);
      const where = t.project ?? (chosen.workdir ?? "").trim();
      if (!where) return yield* Effect.fail(refused(issueWording().draft.noProject));
      const said = word.trim();
      const brief = refinementBrief(t, said, where);
      yield* beforeRefinement(t, said, chosen.id, where);
      // A draft cut short (a restart) may have left the worktree as its refiner had it: each draft starts from main.
      const kept = yield* sessions.clearWorkplace(t.id, where, t.number);
      if (kept.kept) yield* Effect.logInfo(`vibevalley: issue ${t.id}: before its draft: ${kept.reason}`);
      // Always a worktree, even for a profile that works in the project folder: the reset after it must not touch the owner's checkout.
      const hired = yield* hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "refine" }, refining: true });
      if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? issueWording().sendFailed));
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
      if (!d) yield* tell(issueWording().draft.unread(h.name, problem));
      else yield* refined(id, d, f.questions);
    } else yield* tell(issueWording().draft.unfinished(h.name, f.summary));
    yield* sessions.dismiss(f.id, "discard");
    yield* publish(id);
  });

  const clearRefinement = Effect.fn("Issues.clearRefinement")(function* (t: Issue): Effect.fn.Return<WorkplaceRelease, ApiError> {
    if (t.refining) yield* sessions.dismiss(t.refining.session, "discard");
    if (t.project) {
      const kept = yield* sessions.clearWorkplace(t.id, t.project, t.number);
      if (kept.kept) yield* core.notice("warn", issueWording().draft.canceled(cut(t.title, 40), kept.reason));
      return kept;
    }
    return { kept: false };
  });

  return { draft, handedBack, clearRefinement };
}
