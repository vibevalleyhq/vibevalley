// Refinement: an issue in the backlog refined by a helper before anyone works it. Who drafts, what the refiner is told,
// and how what it hands back is read into the issue; the refiner's worktree goes back to main after, and goes away with
// the issue. Who the farm sends for any task (pickAgent) is decided here too.

import type { Agent, Question, Issue } from "@vibevalley/protocol";
import { Effect, Semaphore } from "effect";
import type { SqlClient } from "effect/sql";
import * as q from "../../db/generated/issue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";
import type { AgentShape } from "../agent/agent.ts";
import { cut } from "../base/text.ts";
import type { ChannelShape } from "../channel/chat.ts";
import type { CoreShape } from "../core/core.ts";
import { type ApiError, refused } from "../errors.ts";
import type { ProjectShape, Workplace } from "../project/project.ts";
import { type RuntimeShape, usable } from "../runtime/runtime.ts";
import { chooseAgent } from "../session/rules.ts";
import type { Hired, HireOptions, SessionShape } from "../session/session.ts";
import { isForAssistant } from "./state.ts";
import { refinementBrief, refinementDescription, type IssueRefinement, jsonOrNull, kept, nullText, openQuestions, parseRefinement, splitJob } from "./rules.ts";

/** What drafting needs of the issues around it. */
export interface RefinementDeps {
  readonly core: CoreShape;
  readonly store: AgentShape;
  readonly runtimes: RuntimeShape;
  readonly projects: ProjectShape;
  readonly sessions: SessionShape;
  readonly chat: ChannelShape;
  readonly db: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
  /** One row, or none. */
  readonly one: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A | undefined>;
  readonly inTx: <A, E>(e: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
  readonly get: (ref: string) => Effect.Effect<Issue, ApiError>;
  /** The issue while it was never sent (no task graph's). */
  readonly unsent: (id: string) => Effect.Effect<Issue, ApiError>;
  readonly hire: (agent: Agent, task: string, project: string, opt?: HireOptions) => Effect.Effect<Hired, ApiError>;
  readonly publish: (id: string) => Effect.Effect<void>;
}

export function refinement(d: RefinementDeps) {
  const { core, store, runtimes, projects, sessions, chat, db, one, inTx, get, unsent, hire, publish } = d;
  /** One draft starts at a time: two clicks do not send two sessions. */
  const drafting = Semaphore.makeUnsafe(1);

  const candidatesNow = Effect.suspend(() =>
    Effect.forEach(store.agents(), (agent) => Effect.map(runtimes.assess(agent), (a) => ({ agent: a.agent, usable: usable(a) }))),
  );
  const pickAgent = (task: string, named: string, picked: string) => Effect.map(candidatesNow, (c) => chooseAgent(c, task, named, picked));

  /** Who drafts: its assignee; else whoever was last sent to work in its project, if they can work now; else chooseAgent. */
  const refiner = (t: Issue) =>
    Effect.gen(function* () {
      const candidates = yield* candidatesNow;
      let named = "";
      if (t.assignee) {
        if (!store.agent(t.assignee)) return yield* Effect.fail(refused("帮工档案 " + t.assignee + " 不在了"));
        named = t.assignee;
      } else if (t.project) {
        const last = (yield* one(qs.lastAssigneeIn({ project: t.project })))?.assignee;
        if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
      }
      const chosen = chooseAgent(candidates, "起草 " + t.title, named, "");
      if (!chosen) return yield* Effect.fail(refused("没有能派的帮工来起草"));
      return chosen;
    });

  /** Before its session is sent: the owner's first word is its title, the refiner and the project are its own unless it names them, and an answer clears what it asked. */
  const beforeRefinement = (t: Issue, word: string, agent: string, where: string) =>
    Effect.gen(function* () {
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
              id: t.id,
            }),
          );
          if (word && t.questions.length > 0) yield* db(q.setIssueQuestions({ id: t.id, questions: null }));
        }),
      );
      yield* publish(t.id);
    });

  const refined = (id: string, d: IssueRefinement, questions: readonly Question[] | undefined) =>
    Effect.gen(function* () {
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

  const draft = (id: string, word: string, channel: string) =>
    drafting.withPermits(1)(
      Effect.gen(function* () {
        const t = yield* unsent(id);
        if (isForAssistant(t)) return yield* Effect.fail(refused("这是派给管家的工单：管家自己会看"));
        if (t.status !== "backlog") return yield* Effect.fail(refused("只有备选里的工单能起草：先挪回备选"));
        if (t.refining) return yield* Effect.fail(refused(t.refining.name + " 正在起草：等它交回来"));
        const chosen = yield* refiner(t);
        const where = t.project ?? (chosen.workdir ?? "").trim();
        if (!where) return yield* Effect.fail(refused("没说在哪个项目里做：先选一个项目"));
        const said = word.trim();
        const brief = refinementBrief(t, said, where);
        yield* beforeRefinement(t, said, chosen.id, where);
        // A draft cut short (a restart) may have left the worktree as its refiner had it: each draft starts from main.
        const kept = yield* projects.clear(where, t.number);
        if (kept) yield* Effect.logInfo(`vibevalley: issue ${t.id}: before its draft: ${kept}`);
        // Always a worktree, even for a profile that works in the project folder: the reset after it must not touch the owner's checkout.
        const hired = yield* hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "refine" }, refining: true });
        if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? "派不出去"));
        // Its moves no longer hold todo while it drafts.
        yield* publish(id);
        return yield* get(id);
      }),
    );

  /** A draft's session reported: what it hands back is written into the issue, or the thread says why not; then its worktree goes back to main and it leaves. */
  const handedBack = (f: { id: string; outcome: string; summary: string; questions?: readonly Question[] }) =>
    Effect.gen(function* () {
      const h = sessions.sessionOf(f.id);
      if (!h?.refining || !h.issue) return;
      const id = h.issue;
      const r = sessions.find(f.id);
      const said = r?.lastText ?? "";
      const place: Workplace | undefined = r?.place;
      const thread = yield* chat.jobThread(f.id);
      const tell = (text: string) => (thread ? chat.notice(thread, text, "issue_refinement") : core.notice("warn", text));
      if (f.outcome === "completed") {
        const { draft: d, problem } = parseRefinement(said);
        if (!d) yield* tell(`${h.name} 交回来的草稿读不出来（${problem}），工单没动：再起草一次`);
        else yield* refined(id, d, f.questions);
      } else yield* tell(`${h.name} 没起草完（${f.summary}），工单没动：再起草一次`);
      if (place?.branch) {
        const reset = yield* Effect.result(projects.reset(place));
        if (reset._tag === "Failure") yield* core.notice("warn", `起草的 worktree 没能重置：${reset.failure.message}`);
      }
      yield* sessions.dismiss(f.id);
      yield* publish(id);
    });

  /** An unsent issue going away takes its draft with it: whoever drafts it goes home, and what drafts left is removed. */
  const clearRefinement = (t: Issue) =>
    Effect.gen(function* () {
      if (t.refining) {
        const r = sessions.find(t.refining.session);
        if (r?.place.branch) yield* Effect.ignore(projects.reset(r.place));
        yield* sessions.dismiss(t.refining.session);
      }
      if (t.project) {
        const kept = yield* projects.clear(t.project, t.number);
        if (kept) yield* core.notice("warn", `「${cut(t.title, 40)}」取消了：${kept}`);
      }
    });

  return { pickAgent, draft, handedBack, clearRefinement };
}
