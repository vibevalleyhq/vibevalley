// Everything here runs one at a time.

import { Clock, Context, Effect, Layer, PubSub, Schema, type Scope, Semaphore, Stream, Predicate } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { commandOf } from "@vibevalley/protocol/api";
import { isBusy } from "@vibevalley/protocol/rules";
import type { Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { actsForOwner, type Actor, session as sessionActor, system } from "@/base/actor.ts";
import { clip } from "@/base/clip.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, lookIn, missing, type Next, reasonOf, refused } from "@/errors.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Issue } from "@/issue/issue.ts";
import { Project } from "@/project/project.ts";
import { MergeFailure, type ProjectError } from "@/project/shapes.ts";
import { chooseAgent } from "@/runtime/fit.ts";
import { Runtime } from "@/runtime/runtime.ts";
import { sessionOf } from "@/session/roster.ts";
import { type Hired, type HireOptions, type Roster, type SessionNews, Session } from "@/session/session.ts";

import * as q from "../../db/generated/task_event.sql.ts";
import { changeOf, graphChanges, graphEventText, renderedChanges } from "./changes.ts";
import { type EditResult, editTask, freshTask, removeTask } from "./editing.ts";
import {
  graphActions,
  graphProblems,
  graphView,
  isAcceptance,
  isOpen,
  taskActions,
  taskOf,
  acceptanceChecks,
  acceptancesOf,
  allSettled,
  autoRetries,
  defaultParallel,
  frozenTouched,
  startable,
  withTask,
} from "./graph.ts";
import { graphsOf, graphOf, taskIssueID } from "./issues.ts";
import {
  acceptancePassedText,
  checkFailedText,
  frozenTouchedText,
  graphText,
  splittable,
  mergeNeedsOwner,
  graphMatch,
  graphNews,
  graphTell,
  retryText,
  splitBrief,
  startNeedsOwner,
  taskBrief,
} from "./prompts.ts";
import { parseSplit } from "./splitting.ts";

const readLimit = 1000;
/** What an event row keeps beside its kind: only what it has (an empty list is left out). */
interface EventPayload {
  readonly session?: T.GraphEvent["session"];
  readonly detail?: string;
  readonly changes?: T.GraphEvent["changes"];
  readonly commits?: string[];
}
const EventPayloadSchema: Schema.Codec<EventPayload, Wire<EventPayload>> = Schema.Struct({
  session: Schema.optionalKey(S.SessionId),
  detail: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.mutable(Schema.Array(S.TaskFieldChange))),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

/** What the graph allows now, as the commands that do it: what a refusal of one of its acts offers instead. */
const graphNext = (graph: T.TaskGraph): Next[] =>
  graphActions(graph).map((action) => ({ say: t(`server.task.graphAction.${action}`), run: commandOf("graph.act", [graph.id], { action }) }));

/** What the task allows now, as commands. */
const taskNext = (graph: T.TaskGraph, task: T.Task): Next[] =>
  taskActions(graph, task).map((action) => ({
    say: t("server.task.act.stepAct", { action: t(`server.task.taskAction.${action}`), title: task.title }),
    run: commandOf("graph.task.act", [graph.id, task.id], { action }),
  }));

export class Task extends Context.Service<
  Task,
  {
    readonly split: (goal: string, project: string, agent: string, by: Actor) => Effect.Effect<string, ApiError>;
    /** A helper finds its issue is several people's work: the issue becomes the graph, its tasks the issues under it, and they start at once. */
    readonly splitIssue: (session: string, title: string, tasks: readonly T.TaskDraft[]) => Effect.Effect<string, ApiError>;
    /** The same split, asked of the session working the issue now: it is that session's branch the graph opens from. */
    readonly splitIssueOf: (issue: string, title: string, tasks: readonly T.TaskDraft[]) => Effect.Effect<string, ApiError>;
    readonly act: (id: string, action: T.GraphAction, by: Actor) => Effect.Effect<string, ApiError>;
    readonly taskAct: (id: string, task: string, action: T.TaskAction, by: Actor) => Effect.Effect<string, ApiError>;
    readonly editTask: (id: string, task: string, edit: T.TaskEdit, by: Actor) => Effect.Effect<string, ApiError>;
    readonly removeTask: (id: string, task: string, by: Actor) => Effect.Effect<string, ApiError>;
    /** What removeTask would do, refused as it would be; nothing changes. */
    readonly previewRemoveTask: (id: string, task: string) => Effect.Effect<T.Preview, ApiError>;
    readonly events: (id: string) => Effect.Effect<T.GraphEvent[]>;
    /** The task graphs now, as the board has them. */
    readonly graphs: () => T.TaskGraph[];
    readonly graph: (id: string) => Effect.Effect<T.TaskGraph, ApiError>;
    readonly changes: (id: string) => Effect.Effect<T.Changes, ApiError>;
    /** What the orchestrator is told about graphs, subscribed before it returns. */
    readonly news: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
    /** Once the sessions came back (Agent Sessions' startup): a graph cut off while splitting is abandoned, one cut off with
     * steps at work pauses, and a running one goes on. */
    readonly comeBack: Effect.Effect<void>;
  }
>()("vibevalley/Task") {
  static readonly layer = (options?: TaskOptions) => Layer.effect(Task, make(options));
}

const withNote = (graph: T.TaskGraph, note: string): T.TaskGraph => ({ ...graph, note });

const unmanned = (n: T.Task): T.Task => {
  const { session: _, ...rest } = n;
  return rest;
};

/** The sessions a graph's steps are worked by; tests play them. */
export interface TaskWork {
  readonly hire: (agent: T.Agent, brief: string, project: string, opt: HireOptions) => Effect.Effect<Hired>;
  readonly tell: (id: string, text: string) => Effect.Effect<string>;
  readonly dismiss: Session["Service"]["dismiss"];
  readonly find: (id: string) => Roster | undefined;
  readonly handOver: Session["Service"]["handOver"];
}

/** The git a graph's branches live in; tests play it. */
export interface TaskGit {
  readonly run: (cwd: string, command: string) => Effect.Effect<{ readonly ok: boolean; readonly output: string }>;
  readonly openBranch: (project: string, branch: string, from?: string) => Effect.Effect<void, ProjectError>;
  readonly mergeBranch: (project: string, branch: string) => Effect.Effect<string, MergeFailure>;
  readonly branchChanges: (project: string, branch: string) => Effect.Effect<T.Changes | undefined, ProjectError>;
  readonly changedFiles: (cwd: string, base: string) => Effect.Effect<string[], ProjectError>;
  readonly mergeInto: Project["Service"]["mergeInto"];
}

export interface TaskOptions {
  /** Whether a profile can work now; the runtimes say otherwise. */
  readonly usable?: (a: T.Agent) => boolean;
  readonly work?: TaskWork;
  readonly git?: TaskGit;
}

interface Verification {
  readonly frozen: string[];
  readonly rejected?: { readonly why: string; readonly fix: string };
}

export const make = (options: TaskOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const core = yield* Core;
    const issues = yield* Issue;
    const store = yield* Agent;
    const runtimes = yield* Runtime;
    const live = yield* Session;
    const work: TaskWork = options.work ?? {
      hire: issues.hire,
      tell: (id, text) => live.tell(id, text, { kind: "task" }),
      dismiss: live.dismiss,
      find: live.find,
      handOver: live.handOver,
    };
    const projects: TaskGit = options.git ?? (yield* Project);
    const db = yield* Db;
    /** A step's run ending and the person pressing a button must not both read the same graph and write over each other. */
    const lock = yield* Semaphore.make(1);
    const newsHub = yield* scopedPubSub<string>();
    const splitters = new Map<string, string>();
    const splitterTries = new Map<string, number>();

    const tell = (id: string, text: string) => work.tell(id, text);
    const dismiss = (id: string) => Effect.asVoid(work.dismiss(id));
    const notice = (level: "info" | "warn", text: string) => core.notice(level, text);
    const tellOrchestrator = (text: string) => Effect.asVoid(PubSub.publish(newsHub, graphNews.head + text));

    const usableAs = options.usable;
    const candidates = usableAs ? Effect.sync(() => store.agents().map((agent) => ({ agent, usable: usableAs(agent) }))) : runtimes.candidates;

    const get = (id: string) => graphOf(core.state(), id);
    const need = Effect.fnUntraced(function* (id: string) {
      const g = get(id);
      if (!g) return yield* Effect.fail(missing(t("server.task.noGraph", { id }), [lookIn.graph]));
      return g;
    });

    /** The history must never stop the graph itself: what cannot be written is logged. */
    const record = (before: T.TaskGraph | undefined, after: T.TaskGraph, actor: T.ActorKind, why: string) =>
      Effect.forEach(
        graphChanges(before, after),
        (c) => {
          const detail = c.detail || why || undefined;
          const payload = {
            ...(c.session ? { session: c.session } : {}),
            detail: detail ?? "",
            ...(c.changes && c.changes.length > 0 ? { changes: c.changes } : {}),
            ...(c.commits && c.commits.length > 0 ? { commits: c.commits } : {}),
          };
          return db
            .attempt(
              q.addGraphEvent({
                id: newId(),
                graph_id: c.graph,
                task_id: c.task ?? null,
                kind: c.kind,
                actor,
                payload: JSON.stringify(payload),
                created_at: clock.currentTimeMillisUnsafe(),
              }),
            )
            .pipe(bestEffort("vibevalley: a task graph event was not kept"));
        },
        { discard: true },
      );

    const put = Effect.fn("Task.put")(function* (graph: T.TaskGraph, by: Actor, why: string = "") {
      const before = get(graph.id);
      yield* issues
        .putTask(graph)
        .pipe(Effect.catchTag("SqlError", (e) => Effect.fail(refused(t("server.task.notSaved", { title: graph.title, why: causeMessage(e) })))));
      yield* record(before, graph, by.kind, why);
    });

    const putSystem = (graph: T.TaskGraph) => put(graph, system);

    const giveUp = Effect.fn("Task.giveUp")(function* (graph: T.TaskGraph, why: string) {
      const splitter = splitters.get(graph.id);
      yield* putSystem(withNote({ ...graph, state: "abandoned" }, why));
      splitters.delete(graph.id);
      if (splitter) yield* dismiss(splitter);
      yield* notice("warn", t("server.task.notice.notSplit", { title: graph.title, why }));
      yield* tellOrchestrator(graphNews.notSplit(graph.id, graph.title, why));
    });

    const split = Effect.fn("Task.split")(function* (graph: T.TaskGraph, session: T.Session, outcome: string, summary: string) {
      if (graph.state !== "splitting") return;
      const tries = splitterTries.get(graph.id) ?? 0;
      if (outcome === "interrupted") return yield* giveUp(graph, t("server.task.notice.splitStopped"));
      if (outcome === "failed") {
        if (tries >= 1) return yield* giveUp(graph, t("server.task.notice.plannerFailed", { summary }));
        splitterTries.set(graph.id, tries + 1);
        yield* tell(session.id, graphTell.retrySplit);
        return;
      }
      const parsed = parseSplit(work.find(session.id)?.lastText ?? "");
      if (!parsed.ok) {
        if (tries >= 1) return yield* giveUp(graph, t("server.task.notice.noGraph", { problem: parsed.problems[0] ?? "" }));
        splitterTries.set(graph.id, tries + 1);
        yield* tell(session.id, graphTell.fixGraph(parsed.problems));
        return;
      }
      const draft = withNote({ ...graph, title: parsed.title ?? "", tasks: parsed.tasks, state: "draft" }, "");
      yield* putSystem(draft);
      splitters.delete(graph.id);
      splitterTries.delete(graph.id);
      yield* dismiss(session.id);
      yield* notice("info", t("server.task.notice.drafted", { title: draft.title, steps: draft.tasks.length }));
      yield* tellOrchestrator(graphNews.drafted(draft.id, graphText(draft)));
    });

    const cron = Effect.fnUntraced(function* (id: string): Effect.fn.Return<void, ApiError> {
      let graph = get(id);
      if (!graph || graph.state !== "running") return;
      for (const task of startable(graph)) {
        const agent = chooseAgent(yield* candidates, task.brief, task.agent ?? "", "");
        let refusal = t("server.task.notice.noHelper");
        let hired: T.Session | undefined;
        if (agent) {
          const tag: T.SessionGraph = { id: graph.id, task: task.id };
          const got = yield* work.hire(agent, taskBrief(graph, task), graph.project, {
            worktree: true,
            taskGraph: tag,
            base: graph.branch ?? "",
            trigger: { kind: "task" },
            issue: taskIssueID(graph.id, task.id),
          });
          hired = got.session;
          refusal = got.refused ?? refusal;
        }
        if (!hired) {
          // Not now: it waits, and is tried again when a session finishes or leaves.
          const note = t("server.task.notice.waits", { title: task.title, why: refusal });
          if (graph.note !== note) yield* putSystem(withNote(graph, note));
          return;
        }
        const session = hired.id;
        graph = withTask(withNote(graph, ""), task.id, (n) => ({ ...n, state: "working", session, tries: 0 }));
        // Whatever stops the save (a refusal, a defect, an interruption), the session hired for it does not stay.
        const saved = yield* Effect.exit(putSystem(graph));
        if (saved._tag === "Failure") {
          yield* Effect.uninterruptible(dismiss(session).pipe(bestEffort(`vibevalley: could not dismiss ${session} after the graph was not saved`)));
          return yield* saved;
        }
      }
    });

    const taskFailed = Effect.fn("Task.taskFailed")(function* (graph: T.TaskGraph, task: T.Task, why: string) {
      yield* putSystem(withTask(graph, task.id, (n) => ({ ...n, state: "failed", conclusion: why, failures: (n.failures ?? 0) + 1 })));
      yield* notice("warn", t("server.task.notice.taskFailed", { graph: graph.title, task: task.title, why }));
      yield* tellOrchestrator(graphNews.taskFailed(graph.id, graph.title, task.title, task.id, why));
    });

    const sendBack = Effect.fn("Task.sendBack")(function* (graph: T.TaskGraph, task: T.Task, session: string, text: string, why: string) {
      if (task.tries >= autoRetries) return yield* taskFailed(graph, task, why);
      yield* put(
        withTask(graph, task.id, (n) => ({ ...n, tries: n.tries + 1 })),
        system,
        why,
      );
      yield* tell(session, text);
    });

    /** Runs while handOver holds the stopped session; a failed check is acted on after that hold ends. */
    const verified = Effect.fnUntraced(function* (graph: T.TaskGraph, task: T.Task, cwd: string) {
      const rejected = (why: string, fix = ""): Verification => ({ frozen: [], rejected: { why, fix } });
      let changed: string[] = [];
      if (graph.branch && (isAcceptance(task) || acceptancesOf(graph, task).length > 0)) {
        const files = yield* Effect.result(projects.changedFiles(cwd, graph.branch));
        if (files._tag === "Failure") return rejected(t("server.task.notice.unknownFiles", { why: files.failure.message }));
        changed = files.success;
      }
      if (isAcceptance(task) && task.check) {
        if ((yield* projects.run(cwd, task.check)).ok)
          return rejected(t("server.task.notice.acceptancePassed", { check: task.check }), acceptancePassedText(task.check));
        return { frozen: changed };
      }
      const touched = frozenTouched(graph, task, changed);
      if (touched.length > 0) return rejected(t("server.task.notice.frozenTouched", { files: list(touched) }), frozenTouchedText(touched));
      for (const check of [...(task.check ? [task.check] : []), ...acceptanceChecks(graph, task)]) {
        const ran = yield* projects.run(cwd, check);
        if (!ran.ok) return rejected(t("server.task.notice.checkFailed", { check }), checkFailedText(check, ran.output));
      }
      return { frozen: [] };
    });

    const taskDone = Effect.fn("Task.taskDone")(function* (graph: T.TaskGraph, task: T.Task, sessionId: string, conclusion: string) {
      const session = live.sessionOf(sessionId);
      if (!graph.branch) return yield* taskFailed(graph, task, t("server.task.notice.noBranch"));
      const target = graph.branch;
      let verification: Verification | undefined;
      const merged = yield* Effect.result(
        work.handOver(
          sessionId,
          // Its issue is done, delivered into the graph's branch (graphIssues): the session leaves as a completed one.
          "completed",
          (place) =>
            Effect.gen(function* () {
              verification = yield* verified(graph, task, place.cwd);
              if (verification.rejected) return yield* MergeFailure.failedCheck(verification.rejected.why);
              return yield* projects.mergeInto(place, target);
            }),
          "helper",
        ),
      );
      if (merged._tag === "Failure") {
        if (verification?.rejected) {
          const { why, fix } = verification.rejected;
          return yield* fix ? sendBack(graph, task, sessionId, fix, why) : taskFailed(graph, task, why);
        }
        const f = merged.failure;
        // A failed check or a conflict sends the helper back to fix it (a conflict: it merges the graph's branch into its
        // own); then this runs again.
        if (Predicate.isTagged(f, "NotTakenIn")) return yield* f.fix ? sendBack(graph, task, sessionId, f.fix, f.short) : taskFailed(graph, task, f.short);
        return yield* taskFailed(graph, task, reasonOf(f));
      }
      let next = withTask(graph, task.id, (n) => ({
        ...unmanned(n),
        state: "merged",
        conclusion,
        commits: [...(merged.success.hashes ?? [])],
        ...(isAcceptance(n) ? { frozen: verification?.frozen ?? [] } : {}),
        ...(session?.spent ? { spent: { ...session.spent } } : {}),
      }));
      if (allSettled(next)) next = withNote({ ...next, state: "ready" }, "");
      yield* putSystem(next).pipe(Effect.mapError((e) => refused(t("server.task.notice.stepNotSaved", { title: task.title, why: reasonOf(e) }))));
      if (next.state === "ready") {
        yield* notice("info", t("server.task.notice.ready", { title: next.title }));
        yield* tellOrchestrator(graphNews.ready(next.id, next.title, graphText(next)));
      }
    });

    const taskEnded = Effect.fn("Task.taskEnded")(function* (graph: T.TaskGraph, task: T.Task, session: T.Session, outcome: string, summary: string) {
      if (outcome === "completed") return yield* taskDone(graph, task, session.id, summary);
      if (outcome === "failed") return yield* sendBack(graph, task, session.id, retryText(task), summary);
      if (graph.state !== "running") return;
      yield* putSystem(withNote({ ...graph, state: "paused" }, t("server.task.notice.stepStopped", { title: task.title })));
    });

    const follow = (n: SessionNews) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (n._tag === "reported") {
            const f = n.report;
            const session = n.session;
            if (session && !session.graph && session.issue) {
              // The helper that split its issue: the steps do the work now.
              const graph = get(session.issue);
              if (graph && graph.state !== "splitting") yield* dismiss(session.id);
            } else if (session?.graph) {
              const graph = get(session.graph.id);
              if (graph && isOpen(graph)) {
                if (session.graph.task === undefined) yield* split(graph, session, f.outcome, f.summary);
                else {
                  const task = taskOf(graph, session.graph.task);
                  if (task && task.session === session.id && task.state === "working") yield* taskEnded(graph, task, session, f.outcome, f.summary);
                }
              }
            }
          } else if (n._tag === "left") {
            const f = n.left;
            // Sent home from outside the graph (a full farm, the person): its step did not get done.
            for (const graph of graphsOf(core.state())) {
              if (!isOpen(graph)) continue;
              if (splitters.get(graph.id) === f.id && graph.state === "splitting") yield* giveUp(graph, t("server.task.notice.plannerGone"));
              const task = graph.tasks.find((n) => n.session === f.id && n.state === "working");
              if (task) yield* taskFailed(withTask(graph, task.id, unmanned), task, t("server.task.notice.helperGone"));
            }
          } else return;
          for (const graph of graphsOf(core.state())) if (graph.state === "running") yield* cron(graph.id);
        }).pipe(Effect.catch((e) => notice("warn", reasonOf(e)))),
      );

    const resumeWorking = Effect.fn("Task.resumeWorking")(function* (id: string) {
      for (const task of get(id)?.tasks ?? []) {
        if (task.state !== "working") continue;
        const graph = get(id);
        if (!graph) return;
        const session = task.session ? live.sessionOf(task.session) : undefined;
        if (!session) {
          yield* putSystem(withTask(graph, task.id, (n) => ({ ...unmanned(n), state: "waiting" })));
          continue;
        }
        if (isBusy(session)) continue;
        if (session.phase._tag === "done") yield* taskDone(graph, task, session.id, session.lastRun?.summary ?? t("server.task.notice.done"));
        else yield* tell(session.id, graphTell.carryOn(task.title));
      }
    });

    const openBranch = Effect.fn("Task.openBranch")(function* (graph: T.TaskGraph, from: string = "") {
      const branch = "vibevalley/task-" + graph.id + "-" + (yield* Clock.currentTimeMillis).toString(36);
      yield* projects.openBranch(graph.project, branch, from).pipe(Effect.mapError((e) => refused(e.message)));
      return branch;
    });

    const edited = Effect.fn("Task.edited")(function* (id: string, change: (g: T.TaskGraph) => EditResult, by: Actor) {
      const result = change(yield* need(id));
      if (!result.ok) return yield* Effect.fail(refused(result.problem));
      yield* put(result.graph, by);
      return t("server.task.act.edited");
    }, lock.withPermits(1));

    // Run by the startup, after the sessions came back and marked the runs that stopped with the server.
    const comeBack = lock.withPermits(1)(
      Effect.gen(function* () {
        for (const graph of graphsOf(core.state())) {
          if (graph.state === "splitting") {
            yield* putSystem(withNote({ ...graph, state: "abandoned" }, t("server.task.notice.restartedSplitting")));
            for (const h of live.presentSessions()) if (h.graph?.id === graph.id && h.graph.task === undefined) yield* dismiss(h.id);
          } else if (graph.state === "running" && graph.tasks.some((n) => n.state === "working")) {
            yield* putSystem(withNote({ ...graph, state: "paused" }, t("server.task.notice.restarted")));
          }
        }
        for (const graph of graphsOf(core.state())) if (graph.state === "running") yield* cron(graph.id);
      }).pipe(Effect.catch((e) => notice("warn", reasonOf(e)))),
    );
    yield* Effect.forkScoped(Stream.runForEach(yield* live.news, (n) => (n._tag === "hired" ? Effect.void : follow(n))));

    const shape = Task.of({
      splitIssueOf: Effect.fn("Task.splitIssueOf")(function* (issue, title, drafts) {
        return yield* shape.splitIssue(
          String(
            core
              .state()
              .issues.find((item) => item.id === issue)
              ?.sessions.at(-1) ?? "",
          ),
          title,
          drafts,
        );
      }),
      graphs: () => graphsOf(core.state()),
      graph: need,
      comeBack,
      split: Effect.fn("Task.split")(function* (goal, project, agent, by) {
        const where = project.trim();
        if (!goal.trim()) return yield* Effect.fail(refused(t("server.task.act.noGoal")));
        if (!where) return yield* Effect.fail(refused(t("server.task.act.noProject")));
        const all = yield* candidates;
        const chosen = chooseAgent(all, graphMatch(goal), agent, "");
        if (!chosen) return yield* Effect.fail(refused(t("server.task.act.noSplitter"), [lookIn.agent]));
        const id = yield* issues.nextTaskId();
        const graph: T.TaskGraph = {
          id,
          title: clip(goal, 24),
          goal: goal.trim(),
          project: where,
          state: "splitting",
          tasks: [],
          parallel: defaultParallel,
          createdAt: yield* Clock.currentTimeMillis,
          note: "",
          ...graphView(),
        };
        yield* put(graph, by);
        const hired = yield* work.hire(
          chosen,
          splitBrief(
            goal,
            where,
            all.filter((c) => c.usable).map((c) => c.agent),
          ),
          where,
          { worktree: true, taskGraph: { id: graph.id }, issue: graph.id, trigger: { kind: "task" } },
        );
        if (!hired.session) {
          const reason = hired.refused || t("server.task.act.notSent");
          yield* put(withNote({ ...graph, state: "abandoned" }, t("server.task.act.plannerNotSent", { why: reason })), by);
          return yield* Effect.fail(refused(reason));
        }
        splitters.set(graph.id, hired.session.id);
        return t("server.task.act.splittingBy", { name: hired.session.name, id: graph.id });
      }, lock.withPermits(1)),
      splitIssue: Effect.fn("Task.splitIssue")(function* (sessionId, title, drafts) {
        const state = core.state();
        const asked = sessionOf(state, sessionId);
        const split = splittable(asked, asked?.issue ? state.issues.find((item) => item.id === asked.issue) : undefined, store.isOrchestrator);
        if (!split.ok) return yield* Effect.fail(refused(split.problem));
        const { session, issue, project } = split;
        const tasks = drafts.map(freshTask);
        const problems = graphProblems(tasks);
        if (problems.length > 0) return yield* Effect.fail(refused(t("server.task.act.stepsWrong", { problems: problems.join("\n- ") })));
        let graph: T.TaskGraph = {
          id: issue.id,
          title: title.trim() || issue.title,
          goal: issue.description,
          project: project,
          tasks,
          parallel: defaultParallel,
          createdAt: issue.createdAt,
          state: "running",
          note: "",
          ...graphView(),
        };
        const branch = yield* openBranch(graph, split.branch);
        graph = { ...graph, branch };
        yield* put(graph, sessionActor(session.id), t("server.task.notice.splitBy", { name: session.name })).pipe(
          Effect.mapError((e) => refused(t("server.task.notice.splitNotSaved", { branch, why: reasonOf(e) }))),
        );
        yield* cron(graph.id);
        yield* notice("info", t("server.task.notice.split", { name: session.name, title: graph.title, n: tasks.length }));
        yield* tellOrchestrator(graphNews.split(session.name, graph.id, tasks.length, graphText(graph)));
        return graphTell.split(graph.title, tasks.length, branch);
      }, lock.withPermits(1)),
      act: Effect.fn("Task.act")(function* (id, action, by) {
        const graph = yield* need(id);
        const not = () =>
          Effect.fail(
            refused(
              t("server.task.act.cannot", {
                title: graph.title,
                state: t(`server.task.graphState.${graph.state}`),
                action: t(`server.task.graphAction.${action}`).toLowerCase(),
              }),
              graphNext(graph),
            ),
          );
        switch (action) {
          case "start": {
            if (!actsForOwner(by)) return yield* Effect.fail(refused(startNeedsOwner));
            if (graph.state !== "draft") return yield* not();
            const problems = graphProblems(graph.tasks);
            if (problems.length > 0) return yield* Effect.fail(refused(problems[0]!));
            const branch = yield* openBranch(graph);
            yield* put(withNote({ ...graph, state: "running", branch }, ""), by).pipe(
              Effect.mapError((e) => refused(t("server.task.act.startNotSaved", { branch, why: reasonOf(e) }))),
            );
            yield* cron(graph.id);
            return t("server.task.act.started", { title: graph.title, branch });
          }
          case "pause":
            if (graph.state !== "running") return yield* not();
            yield* put(withNote({ ...graph, state: "paused" }, t("server.task.act.pausedNote")), by);
            return t("server.task.act.paused", { title: graph.title });
          case "resume":
            if (graph.state !== "paused") return yield* not();
            yield* put(withNote({ ...graph, state: "running" }, ""), by);
            yield* resumeWorking(graph.id);
            yield* cron(graph.id);
            return t("server.task.act.resumed", { title: graph.title });
          case "abandon": {
            if (!isOpen(graph)) return yield* not();
            const next = {
              ...graph,
              state: "abandoned" as const,
              tasks: graph.tasks.map((n) => (n.state === "working" ? { ...unmanned(n), state: "waiting" as const } : n)),
            };
            const kept = graph.branch ? t("server.task.act.branchKeptNote", { branch: graph.branch }) : "";
            yield* put(withNote(next, t("server.task.act.abandonedNote", { kept })), by);
            const splitter = splitters.get(graph.id);
            splitters.delete(graph.id);
            if (splitter) yield* dismiss(splitter);
            for (const n of graph.tasks) if (n.state === "working" && n.session) yield* dismiss(n.session);
            return graph.branch
              ? t("server.task.act.abandonedKept", { title: graph.title, branch: graph.branch })
              : t("server.task.act.abandoned", { title: graph.title });
          }
          case "merge": {
            if (!actsForOwner(by)) return yield* Effect.fail(refused(mergeNeedsOwner));
            if (graph.state !== "ready" || !graph.branch) return yield* not();
            const merged = yield* Effect.result(projects.mergeBranch(graph.project, graph.branch));
            if (merged._tag === "Failure") {
              const f = merged.failure;
              const why = f.kind === "conflict" ? t("server.task.act.conflict", { base: f.base, files: list(f.files) }) : f.reasonText || f.message;
              yield* put(withNote(graph, t("server.task.act.notMergedNote", { why })), by);
              return yield* Effect.fail(refused(t("server.task.act.notMerged", { why, branch: graph.branch })));
            }
            yield* put(withNote({ ...graph, state: "done" }, ""), by).pipe(
              Effect.mapError((e) => refused(t("server.task.act.mergeNotSaved", { why: reasonOf(e) }))),
            );
            yield* notice("info", t("server.task.act.merged", { title: graph.title, text: merged.success }));
            return t("server.task.act.merged", { title: graph.title, text: merged.success });
          }
        }
      }, lock.withPermits(1)),
      taskAct: Effect.fn("Task.taskAct")(function* (id, taskId, action, by) {
        const graph = yield* need(id);
        const task = taskOf(graph, taskId);
        if (!task) return yield* Effect.fail(missing(t("server.task.act.noStep", { id: taskId }), [lookIn.graph]));
        if (graph.state !== "running" && graph.state !== "paused")
          return yield* Effect.fail(refused(t("server.task.act.graphIs", { state: t(`server.task.graphState.${graph.state}`) }), graphNext(graph)));
        switch (action) {
          case "retry": {
            if (task.state !== "failed") return yield* Effect.fail(refused(t("server.task.act.notFailed", { title: task.title }), taskNext(graph, task)));
            const session = task.session ? live.sessionOf(task.session) : undefined;
            if (session && !isBusy(session)) {
              // Its session is still there: it goes on in the same session, with the (perhaps changed) brief.
              yield* put(
                withTask(graph, task.id, (n) => ({ ...n, state: "working", tries: 0 })),
                by,
              );
              yield* tell(session.id, graphTell.retry(retryText(task), task.brief));
              return t("server.task.act.retried", { name: session.name, title: task.title });
            }
            yield* put(
              withTask(graph, task.id, (n) => ({ ...unmanned(n), state: "waiting", tries: 0 })),
              by,
            );
            yield* cron(graph.id);
            return t("server.task.act.requeued", { title: task.title });
          }
          case "skip": {
            if (task.state !== "waiting" && task.state !== "failed")
              return yield* Effect.fail(
                refused(
                  task.state === "working" ? t("server.task.act.working", { title: task.title }) : t("server.task.act.finished", { title: task.title }),
                  taskNext(graph, task),
                ),
              );
            let next = withTask(graph, task.id, (n) => ({ ...unmanned(n), state: "skipped" }));
            if (allSettled(next)) next = withNote({ ...next, state: "ready" }, "");
            yield* put(next, by);
            if (task.session) yield* dismiss(task.session);
            yield* cron(graph.id);
            return t("server.task.act.skipped", { title: task.title });
          }
        }
      }, lock.withPermits(1)),
      editTask: Effect.fn("Task.editTask")(function* (id, task, edit, by) {
        return yield* edited(id, (g) => editTask(g, task, edit), by);
      }),
      removeTask: Effect.fn("Task.removeTask")(function* (id, task, by) {
        return yield* edited(id, (g) => removeTask(g, task), by);
      }),
      previewRemoveTask: Effect.fn("Task.previewRemoveTask")(function* (id, task) {
        const graph = yield* need(id);
        const result = removeTask(graph, task);
        const gone = taskOf(graph, task);
        if (!result.ok || !gone) return yield* Effect.fail(refused(result.ok ? t("server.task.edit.noStep", { id: task }) : result.problem));
        const waiting = graph.tasks.filter((n) => n.needs.includes(task)).map((n) => t("server.task.event.step", { title: n.title }));
        return {
          does: [
            t("server.task.edit.remove", { graph: graph.title, step: gone.title }),
            ...(waiting.length > 0 ? [t("server.task.edit.stopWaiting", { steps: list(waiting) })] : []),
          ],
        };
      }),
      events: Effect.fn("Task.events")(function* (id) {
        const rows = yield* db.run(q.graphEvents({ graph_id: id, n: readLimit }));
        const graph = get(id);
        const titleOf = (node: string) => (graph ? (taskOf(graph, node)?.title ?? node) : node);
        return rows.flatMap((row): T.GraphEvent[] => {
          const p: EventPayload = jsonOrNone(EventPayloadSchema)(row.payload) ?? {};
          const e: T.GraphEvent = {
            id: row.id,
            graph: row.graph_id,
            ...(row.task_id ? { task: row.task_id } : {}),
            kind: row.kind,
            actor: row.actor,
            ...(p.session ? { session: p.session } : {}),
            detail: p.detail ?? "",
            changes: p.changes ?? [],
            commits: p.commits ?? [],
            at: row.created_at,
            text: "",
            actorText: "",
          };
          return [
            {
              ...e,
              changes: renderedChanges(e.changes),
              text: graphEventText(changeOf(e), titleOf),
              actorText: t(`server.task.actor.${e.actor}`),
            },
          ];
        });
      }),
      changes: Effect.fn("Task.changes")(function* (id) {
        const graph = yield* need(id);
        if (!graph.branch) return yield* Effect.fail(refused(t("server.task.act.notStarted", { title: graph.title })));
        const changes = yield* projects.branchChanges(graph.project, graph.branch).pipe(Effect.mapError((e) => refused(e.message)));
        if (!changes) return yield* Effect.fail(refused(t("server.task.act.branchGone", { title: graph.title })));
        return changes;
      }),
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    });
    return shape;
  });

/** Issues' startup: the task graphs come back. */
export const start = Layer.effectDiscard(Effect.flatMap(Task, (item) => item.comeBack));
