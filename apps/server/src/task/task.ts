// Task graphs: a job split into steps, each worked by its own session on a branch of the graph's,
// merged back into the graph's branch when it is verified, and the whole graph merged into the main branch once every
// step is settled. A graph's sessions are followed through the core state's facts: a session's run ending is the cue.
// Everything here runs one at a time.

import {
  type Agent,
  type Changes,
  type GraphAction,
  type GraphActor,
  GraphActorValues,
  type GraphEvent,
  type GraphEventKind,
  type Preview,
  GraphEventKindValues,
  type Session,
  type SessionGraph,
  type Task,
  type TaskAction,
  type TaskEdit,
  type TaskGraph,
} from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";
import { isBusy } from "@vibevalley/protocol/rules";
import { sessionOf } from "../session/state.ts";
import { graphActions, graphActionText, graphProblems, graphStateText, isAcceptance, isOpen, taskActions, taskActionText, taskOf } from "./graph.ts";
import { graphsOf } from "./issues.ts";
import { clip } from "../base/text.ts";
import {
  acceptanceChecks,
  acceptancePassedText,
  acceptancesOf,
  allSettled,
  autoRetries,
  changeOf,
  checkFailedText,
  defaultParallel,
  type EditResult,
  editTask,
  freshTask,
  frozenTouched,
  frozenTouchedText,
  graphOf,
  graphText,
  issueSplitRefusal,
  parseSplit,
  removeTask,
  retryText,
  startable,
  type StepDraft,
  taskBrief,
  taskIssueID,
  withTask,
} from "./rules.ts";
import { actorText, graphChanges, graphEventText } from "./changes.ts";
import { Clock, Context, Effect, Layer, PubSub, Schema, type Scope, Semaphore, Stream } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { causeMessage, Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { jsonOrNone } from "../base/json.ts";
import { Core } from "../core/core.ts";
import { type ApiError, lookIn, missing, type Next, reasonOf, refused } from "../errors.ts";
import { Issues } from "../issue/issue.ts";
import { MergeFailure, ProjectError, type ProjectShape, Projects } from "../project/project.ts";
import { chooseAgent } from "../runtime/rules.ts";
import { Runtimes } from "../runtime/runtime.ts";
import { splitBrief } from "./rules.ts";
import { type Hired, type HireOptions, NotTakenIn, type Roster, type SessionNews, type SessionShape, Sessions } from "../session/session.ts";
import * as q from "../../db/generated/task_event.sql.ts";

const readLimit = 1000;
type EventPayload = Pick<GraphEvent, "session" | "detail" | "changes" | "commits">;
const EventPayloadSchema: Schema.Codec<EventPayload, Wire<EventPayload>> = Schema.Struct({
  session: Schema.optionalKey(S.SessionId),
  detail: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.mutable(Schema.Array(S.TaskFieldChange))),
  commits: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

/** What the graph allows now, as the commands that do it: what a refusal of one of its acts offers instead. */
const graphNext = (graph: TaskGraph): Next[] =>
  graphActions(graph).map((action) => ({ say: graphActionText[action], run: ["graph", "act", graph.id, "--json", JSON.stringify({ action })] }));

/** What the step allows now, as commands. */
const stepNext = (graph: TaskGraph, task: Task): Next[] =>
  taskActions(graph, task).map((action) => ({
    say: `${taskActionText[action]}「${task.title}」`,
    run: ["graph", "task-act", graph.id, task.id, "--json", JSON.stringify({ action })],
  }));

export interface TaskShape {
  readonly split: (goal: string, project: string, agent: string, by: GraphActor) => Effect.Effect<string, ApiError>;
  /** A helper finds its issue is several people's work: the issue becomes the graph, its steps the issues under it, and they start at once. */
  readonly splitIssue: (session: string, title: string, steps: readonly StepDraft[]) => Effect.Effect<string, ApiError>;
  readonly act: (id: string, action: GraphAction, by: GraphActor) => Effect.Effect<string, ApiError>;
  readonly taskAct: (id: string, task: string, action: TaskAction, by: GraphActor) => Effect.Effect<string, ApiError>;
  readonly editTask: (id: string, task: string, edit: TaskEdit, by: GraphActor) => Effect.Effect<string, ApiError>;
  readonly removeTask: (id: string, task: string, by: GraphActor) => Effect.Effect<string, ApiError>;
  /** What removeTask would do, refused as it would be; nothing changes. */
  readonly previewRemoveTask: (id: string, task: string) => Effect.Effect<Preview, ApiError>;
  readonly events: (id: string) => Effect.Effect<GraphEvent[]>;
  /** The task graphs now, as the board has them. */
  readonly graphs: () => TaskGraph[];
  readonly changes: (id: string) => Effect.Effect<Changes, ApiError>;
  /** What the orchestrator is told about graphs, subscribed before it returns. */
  readonly news: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
  /** Once the sessions came back (Agent Sessions' startup): a graph cut off while splitting is abandoned, one cut off with
   * steps at work pauses, and a running one goes on. */
  readonly comeBack: Effect.Effect<void>;
}

export class Tasks extends Context.Service<Tasks, TaskShape>()("vibevalley/Task") {}

const withNote = (graph: TaskGraph, note: string): TaskGraph => {
  const { note: _, ...rest } = graph;
  return note ? { ...rest, note } : rest;
};

const unmanned = (n: Task): Task => {
  const { session: _, ...rest } = n;
  return rest;
};

/** The sessions a graph's steps are worked by; tests play them. */
export interface TaskWork {
  readonly hire: (agent: Agent, task: string, project: string, opt: HireOptions) => Effect.Effect<Hired>;
  readonly tell: (id: string, text: string) => Effect.Effect<string>;
  readonly dismiss: SessionShape["dismiss"];
  readonly find: (id: string) => Roster | undefined;
  readonly handOver: SessionShape["handOver"];
}

/** The git a graph's branches live in; tests play it. */
export interface TaskGit {
  readonly run: (cwd: string, command: string) => Effect.Effect<{ readonly ok: boolean; readonly output: string }>;
  readonly openBranch: (project: string, branch: string, from?: string) => Effect.Effect<void, ProjectError>;
  readonly mergeBranch: (project: string, branch: string) => Effect.Effect<string, MergeFailure>;
  readonly branchChanges: (project: string, branch: string) => Effect.Effect<Changes | undefined, ProjectError>;
  readonly changedFiles: (cwd: string, base: string) => Effect.Effect<string[], ProjectError>;
  readonly mergeInto: ProjectShape["mergeInto"];
}

export interface TaskOptions {
  /** Whether a profile can work now; the runtimes say otherwise. */
  readonly usable?: (a: Agent) => boolean;
  readonly work?: TaskWork;
  readonly git?: TaskGit;
}

interface Verification {
  readonly frozen: string[];
  readonly rejected?: { readonly why: string; readonly fix: string };
}

export const make = (options: TaskOptions = {}) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const issues = yield* Issues;
    const store = yield* Agents;
    const runtimes = yield* Runtimes;
    const live = yield* Sessions;
    const work: TaskWork = options.work ?? {
      hire: issues.hire,
      tell: (id, text) => live.tell(id, text, { kind: "task" }),
      dismiss: live.dismiss,
      find: live.find,
      handOver: live.handOver,
    };
    const projects: TaskGit = options.git ?? (yield* Projects);
    const sql = yield* SqlClient.SqlClient;
    const { run: db } = yield* Db;
    /** A step's run ending and the person pressing a button must not both read the same graph and write over each other. */
    const lock = yield* Semaphore.make(1);
    const newsHub = yield* PubSub.unbounded<string>();
    const splitters = new Map<string, string>();
    const splitterTries = new Map<string, number>();

    const tell = (id: string, text: string) => work.tell(id, text);
    const dismiss = (id: string) => Effect.asVoid(work.dismiss(id));
    const notice = (level: "info" | "warn", text: string) => core.notice(level, text);
    const tellOrchestrator = (text: string) => Effect.asVoid(PubSub.publish(newsHub, "【计划】" + text));

    const usableAs = options.usable;
    const candidates = usableAs ? Effect.sync(() => store.agents().map((agent) => ({ agent, usable: usableAs(agent) }))) : runtimes.candidates;

    const get = (id: string) => graphOf(core.state(), id);
    const need = (id: string) => {
      const g = get(id);
      return g ? Effect.succeed(g) : Effect.fail(missing(`没有 ${id} 这个计划`, [lookIn.graph]));
    };

    /** The history must never stop the graph itself: what cannot be written is logged. */
    const record = (before: TaskGraph | undefined, after: TaskGraph, actor: GraphActor, why: string) =>
      Effect.forEach(
        graphChanges(before, after),
        (c) => {
          const detail = c.detail || why || undefined;
          const payload = {
            ...(c.session ? { session: c.session } : {}),
            ...(detail ? { detail } : {}),
            ...(c.changes && c.changes.length > 0 ? { changes: c.changes } : {}),
            ...(c.commits && c.commits.length > 0 ? { commits: c.commits } : {}),
          };
          return Effect.provideService(
            q.addGraphEvent({
              id: newId(),
              graph_id: c.graph,
              task_id: c.task ?? null,
              kind: c.kind,
              actor,
              payload: JSON.stringify(payload),
              created_at: Date.now(),
            }),
            SqlClient.SqlClient,
            sql,
          ).pipe(Effect.catch((e) => Effect.logWarning(`vibevalley: a task graph event was not kept: ${String(e)}`)));
        },
        { discard: true },
      );

    const put = Effect.fn("Tasks.put")(function* (graph: TaskGraph, by: GraphActor, why = "") {
      const before = get(graph.id);
      yield* issues
        .putTask(graph)
        .pipe(Effect.catchDefect((d) => (SqlError.isSqlError(d) ? Effect.fail(refused(`计划「${graph.title}」没能保存：${causeMessage(d)}`)) : Effect.die(d))));
      yield* record(before, graph, by, why);
    });

    const putSystem = (graph: TaskGraph) => put(graph, "system");

    const giveUp = Effect.fn("Tasks.giveUp")(function* (graph: TaskGraph, why: string) {
      const splitter = splitters.get(graph.id);
      yield* putSystem(withNote({ ...graph, state: "abandoned" }, why));
      splitters.delete(graph.id);
      if (splitter) yield* dismiss(splitter);
      yield* notice("warn", "计划「" + graph.title + "」没拆成：" + why);
      yield* tellOrchestrator(graph.id + "「" + graph.title + "」没拆成：" + why + "。问主人要不要换个说法再拆。");
    });

    const split = Effect.fn("Tasks.split")(function* (graph: TaskGraph, session: Session, outcome: string, summary: string) {
      if (graph.state !== "splitting") return;
      const tries = splitterTries.get(graph.id) ?? 0;
      if (outcome === "interrupted") return yield* giveUp(graph, "规划被叫停了");
      if (outcome === "failed") {
        if (tries >= 1) return yield* giveUp(graph, "规划的帮工出错了：" + summary);
        splitterTries.set(graph.id, tries + 1);
        yield* tell(session.id, "上一轮没做成。看一下报错，接着把计划拆完，最后用 json 代码块给出。");
        return;
      }
      const parsed = parseSplit(work.find(session.id)?.lastText ?? "");
      if (!parsed.ok) {
        if (tries >= 1) return yield* giveUp(graph, "没给出能用的计划：" + (parsed.problems[0] ?? ""));
        splitterTries.set(graph.id, tries + 1);
        yield* tell(session.id, "计划有问题：\n" + parsed.problems.map((x) => "- " + x).join("\n") + "\n\n改好，在最后用一个 json 代码块重新给出整张计划。");
        return;
      }
      const draft = withNote({ ...graph, ...(parsed.title ? { title: parsed.title } : {}), tasks: parsed.tasks, state: "draft" }, "");
      yield* putSystem(draft);
      splitters.delete(graph.id);
      splitterTries.delete(graph.id);
      yield* dismiss(session.id);
      yield* notice("info", `计划「${draft.title}」拆好了，${draft.tasks.length} 步：在「计划」里看过再开工`);
      yield* tellOrchestrator(draft.id + " 拆好了，等主人看过再开工（graph_action start）。用一两句话告诉主人拆成了哪几步。\n" + graphText(draft));
    });

    const recurrence = Effect.fnUntraced(function* (id: string): Effect.fn.Return<void, ApiError> {
      let graph = get(id);
      if (!graph || graph.state !== "running") return;
      for (const task of startable(graph)) {
        const agent = chooseAgent(yield* candidates, task.brief, task.agent ?? "", "");
        let refusal = "没有能派的帮工";
        let hired: Session | undefined;
        if (agent) {
          const tag: SessionGraph = { id: graph.id, task: task.id };
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
          const note = "「" + task.title + "」先等着：" + refusal;
          if (graph.note !== note) yield* putSystem(withNote(graph, note));
          return;
        }
        const session = hired.id;
        graph = withTask(withNote(graph, ""), task.id, (n) => ({ ...n, state: "working", session, tries: 0 }));
        // Whatever stops the save (a refusal, a defect, an interruption), the session hired for it does not stay.
        const saved = yield* Effect.exit(putSystem(graph));
        if (saved._tag === "Failure") {
          yield* Effect.uninterruptible(
            dismiss(session).pipe(
              Effect.catchCause((cause) => Effect.logWarning(`vibevalley: could not dismiss ${session} after the graph was not saved`, cause)),
            ),
          );
          return yield* saved;
        }
      }
    });

    const taskFailed = Effect.fn("Tasks.taskFailed")(function* (graph: TaskGraph, task: Task, why: string) {
      yield* putSystem(withTask(graph, task.id, (n) => ({ ...n, state: "failed", conclusion: why, failures: (n.failures ?? 0) + 1 })));
      yield* notice("warn", "计划「" + graph.title + "」的「" + task.title + "」没做成：" + why);
      yield* tellOrchestrator(
        graph.id +
          " 的「" +
          task.title +
          "」（" +
          task.id +
          "）没做成：" +
          why +
          "。它后面的步骤在等；问主人是重试（task_action retry）、改工单，还是跳过（task_action skip）。",
      );
    });

    const sendBack = Effect.fn("Tasks.sendBack")(function* (graph: TaskGraph, task: Task, session: string, text: string, why: string) {
      if (task.tries >= autoRetries) return yield* taskFailed(graph, task, why);
      yield* put(
        withTask(graph, task.id, (n) => ({ ...n, tries: n.tries + 1 })),
        "system",
        why,
      );
      yield* tell(session, text);
    });

    /** Runs while handOver holds the stopped session; a failed check is acted on after that hold ends. */
    const verified = Effect.fnUntraced(function* (graph: TaskGraph, task: Task, cwd: string) {
      const rejected = (why: string, fix = ""): Verification => ({ frozen: [], rejected: { why, fix } });
      let changed: string[] = [];
      if (graph.branch && (isAcceptance(task) || acceptancesOf(graph, task).length > 0)) {
        const files = yield* Effect.result(projects.changedFiles(cwd, graph.branch));
        if (files._tag === "Failure") return rejected("看不出它改了哪些文件：" + files.failure.message);
        changed = files.success;
      }
      if (isAcceptance(task) && task.check) {
        if ((yield* projects.run(cwd, task.check)).ok) return rejected("验收 " + task.check + " 现在就通过了", acceptancePassedText(task.check));
        return { frozen: changed };
      }
      const touched = frozenTouched(graph, task, changed);
      if (touched.length > 0) return rejected("改了冻结的验收：" + touched.join("、"), frozenTouchedText(touched));
      for (const check of [...(task.check ? [task.check] : []), ...acceptanceChecks(graph, task)]) {
        const ran = yield* projects.run(cwd, check);
        if (!ran.ok) return rejected("做完跑 " + check + " 没通过", checkFailedText(check, ran.output));
      }
      return { frozen: [] };
    });

    const taskDone = Effect.fn("Tasks.taskDone")(function* (graph: TaskGraph, task: Task, sessionId: string, conclusion: string) {
      const session = live.sessionOf(sessionId);
      if (!graph.branch) return yield* taskFailed(graph, task, "计划还没有分支");
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
              if (verification.rejected) return yield* Effect.fail(MergeFailure.check(verification.rejected.why));
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
        if (f instanceof NotTakenIn) return yield* f.fix ? sendBack(graph, task, sessionId, f.fix, f.short) : taskFailed(graph, task, f.short);
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
      yield* putSystem(next).pipe(Effect.mapError((e) => refused(`步骤「${task.title}」已合进计划分支，但完成状态没能保存：${reasonOf(e)}`)));
      if (next.state === "ready") {
        yield* notice("info", "计划「" + next.title + "」都做完了：在「计划」里看看改动，合进主分支");
        yield* tellOrchestrator(
          next.id + "「" + next.title + "」都做完了，等主人合进主分支（graph_action merge）。用两三句话告诉主人做成了什么。\n" + graphText(next),
        );
      }
    });

    const taskEnded = Effect.fn("Tasks.taskEnded")(function* (graph: TaskGraph, task: Task, session: Session, outcome: string, summary: string) {
      if (outcome === "completed") return yield* taskDone(graph, task, session.id, summary);
      if (outcome === "failed") return yield* sendBack(graph, task, session.id, retryText(task), summary);
      if (graph.state !== "running") return;
      yield* putSystem(withNote({ ...graph, state: "paused" }, "「" + task.title + "」被叫停了，计划先暂停；点继续接着做"));
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
              if (splitters.get(graph.id) === f.id && graph.state === "splitting") yield* giveUp(graph, "规划的帮工被请走了");
              const task = graph.tasks.find((n) => n.session === f.id && n.state === "working");
              if (task) yield* taskFailed(withTask(graph, task.id, unmanned), task, "帮工被请走了，这一步没做完");
            }
          } else return;
          for (const graph of graphsOf(core.state())) if (graph.state === "running") yield* recurrence(graph.id);
        }).pipe(Effect.catch((e) => notice("warn", reasonOf(e)))),
      );

    const resumeWorking = Effect.fn("Tasks.resumeWorking")(function* (id: string) {
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
        if (session.phase._tag === "done") yield* taskDone(graph, task, session.id, session.lastRun?.summary ?? "做完了");
        else yield* tell(session.id, "接着把这一步做完：" + task.title);
      }
    });

    const openBranch = Effect.fn("Tasks.openBranch")(function* (graph: TaskGraph, from = "") {
      const branch = "vibevalley/task-" + graph.id + "-" + (yield* Clock.currentTimeMillis).toString(36);
      yield* projects.openBranch(graph.project, branch, from).pipe(Effect.mapError((e) => refused(e.message)));
      return branch;
    });

    const edited = Effect.fn("Tasks.edited")(function* (id: string, change: (g: TaskGraph) => EditResult, by: GraphActor) {
      const result = change(yield* need(id));
      if (!result.ok) return yield* Effect.fail(refused(result.problem));
      yield* put(result.graph, by);
      return "改好了";
    }, lock.withPermits(1));

    // ── coming back: run by the startup, after the sessions came back and marked the runs that stopped with the server ──

    const comeBack = lock.withPermits(1)(
      Effect.gen(function* () {
        for (const graph of graphsOf(core.state())) {
          if (graph.state === "splitting") {
            yield* putSystem(withNote({ ...graph, state: "abandoned" }, "VibeValley 重启了，规划停在了半路：再说一遍要做什么"));
            for (const h of live.presentSessions()) if (h.graph?.id === graph.id && h.graph.task === undefined) yield* dismiss(h.id);
          } else if (graph.state === "running" && graph.tasks.some((n) => n.state === "working")) {
            yield* putSystem(withNote({ ...graph, state: "paused" }, "VibeValley 重启过，计划先暂停了；点继续接着做"));
          }
        }
        for (const graph of graphsOf(core.state())) if (graph.state === "running") yield* recurrence(graph.id);
      }).pipe(Effect.catch((e) => notice("warn", reasonOf(e)))),
    );
    yield* Effect.forkScoped(Stream.runForEach(yield* live.news, (n) => (n._tag === "hired" ? Effect.void : follow(n))));

    const shape: TaskShape = {
      graphs: () => graphsOf(core.state()),
      comeBack,
      split: Effect.fn("Tasks.split")(function* (goal, project, agent, by) {
        const where = project.trim();
        if (!goal.trim()) return yield* Effect.fail(refused("没说要做什么"));
        if (!where) return yield* Effect.fail(refused("没说在哪个项目里做：项目是工作目录下的一个文件夹"));
        const all = yield* candidates;
        const chosen = chooseAgent(all, "规划 计划 拆分 " + goal, agent, "");
        if (!chosen) return yield* Effect.fail(refused("没有能派的帮工来拆计划", [lookIn.agent]));
        const id = yield* issues.nextTaskId();
        const graph: TaskGraph = {
          id,
          title: clip(goal, 24),
          goal: goal.trim(),
          project: where,
          state: "splitting",
          tasks: [],
          parallel: defaultParallel,
          createdAt: yield* Clock.currentTimeMillis,
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
          const reason = hired.refused || "没派出去";
          yield* put(withNote({ ...graph, state: "abandoned" }, "规划的帮工派不出去：" + reason), by);
          return yield* Effect.fail(refused(reason));
        }
        splitters.set(graph.id, hired.session.id);
        return `${hired.session.name} 去看代码、拆计划了（${graph.id}）。拆好了会放在「计划」里，你看过再开工。`;
      }, lock.withPermits(1)),
      splitIssue: Effect.fn("Tasks.splitIssue")(function* (sessionId, title, steps) {
        const state = core.state();
        const session = sessionOf(state, sessionId);
        const issue = session?.issue ? (state.issues ?? []).find((t) => t.id === session.issue) : undefined;
        const why = issueSplitRefusal(session, issue);
        if (why) return yield* Effect.fail(refused(why));
        const tasks = steps.map(freshTask);
        const problems = graphProblems(tasks);
        if (problems.length > 0) return yield* Effect.fail(refused("步骤有问题，改好再拆：\n- " + problems.join("\n- ")));
        let graph: TaskGraph = {
          id: issue!.id,
          title: title.trim() || issue!.title,
          goal: issue!.description ?? "",
          project: issue!.project!,
          tasks,
          parallel: defaultParallel,
          createdAt: issue!.createdAt,
          state: "running",
        };
        const branch = yield* openBranch(graph, session!.branch ?? "");
        graph = { ...graph, branch };
        yield* put(graph, "session", session!.name + " 拆的").pipe(
          Effect.mapError((e) => refused(`计划分支 ${branch} 已创建，但拆好的工单没能保存：${reasonOf(e)}`)),
        );
        yield* recurrence(graph.id);
        yield* notice("info", `${session!.name} 把工单「${graph.title}」拆成了 ${tasks.length} 张子工单，开工了`);
        yield* tellOrchestrator(`${session!.name} 把工单 ${graph.id} 拆成了 ${tasks.length} 步，直接开工了。\n${graphText(graph)}`);
        return `拆好了：工单「${graph.title}」下面 ${tasks.length} 张子工单，在分支 ${branch} 上开工了，每一步派给一个帮工。你这张工单的活交给它们了：别再改代码，用一两句话汇报拆成了哪几步，这一轮就结束，汇报完你就收工。`;
      }, lock.withPermits(1)),
      act: Effect.fn("Tasks.act")(function* (id, action, by) {
        const graph = yield* need(id);
        const not = () => Effect.fail(refused(`计划「${graph.title}」${graphStateText[graph.state]}，不能${graphActionText[action]}`, graphNext(graph)));
        switch (action) {
          case "start": {
            if (graph.state !== "draft") return yield* not();
            const problems = graphProblems(graph.tasks);
            if (problems.length > 0) return yield* Effect.fail(refused(problems[0]!));
            const branch = yield* openBranch(graph);
            yield* put(withNote({ ...graph, state: "running", branch }, ""), by).pipe(
              Effect.mapError((e) => refused(`计划分支 ${branch} 已创建，但开工状态没能保存：${reasonOf(e)}`)),
            );
            yield* recurrence(graph.id);
            return "计划「" + graph.title + "」开工了，分支 " + branch;
          }
          case "pause":
            if (graph.state !== "running") return yield* not();
            yield* put(withNote({ ...graph, state: "paused" }, "暂停了：正在做的做完，不开新的步骤"), by);
            return "计划「" + graph.title + "」暂停了：正在做的步骤做完，不再开新的";
          case "resume":
            if (graph.state !== "paused") return yield* not();
            yield* put(withNote({ ...graph, state: "running" }, ""), by);
            yield* resumeWorking(graph.id);
            yield* recurrence(graph.id);
            return "计划「" + graph.title + "」接着做了";
          case "abandon": {
            if (!isOpen(graph)) return yield* not();
            const next = {
              ...graph,
              state: "abandoned" as const,
              tasks: graph.tasks.map((n) => (n.state === "working" ? { ...unmanned(n), state: "waiting" as const } : n)),
            };
            const kept = graph.branch ? "；分支 " + graph.branch + " 留着" : "";
            yield* put(withNote(next, "放弃了" + kept), by);
            const splitter = splitters.get(graph.id);
            splitters.delete(graph.id);
            if (splitter) yield* dismiss(splitter);
            for (const n of graph.tasks) if (n.state === "working" && n.session) yield* dismiss(n.session);
            return "计划「" + graph.title + "」放弃了" + (graph.branch ? "，分支 " + graph.branch + " 留着" : "");
          }
          case "merge": {
            if (graph.state !== "ready" || !graph.branch) return yield* not();
            const merged = yield* Effect.result(projects.mergeBranch(graph.project, graph.branch));
            if (merged._tag === "Failure") {
              const f = merged.failure;
              const why =
                f.kind === "conflict" ? "合进 " + f.base + " 会冲突（" + f.files.join("、") + "）：" + f.base + " 在这期间变了" : f.reasonText || f.message;
              yield* put(withNote(graph, "没合进去：" + why), by);
              return yield* Effect.fail(refused("没合进去：" + why + "。计划分支 " + graph.branch + " 留着"));
            }
            yield* put(withNote({ ...graph, state: "done" }, ""), by).pipe(
              Effect.mapError((e) => refused(`计划分支已合进主分支，但完成状态没能保存：${reasonOf(e)}`)),
            );
            yield* notice("info", "计划「" + graph.title + "」合进去了：" + merged.success);
            return "计划「" + graph.title + "」合进去了：" + merged.success;
          }
        }
        return yield* Effect.fail(refused(`不认识 ${String(action satisfies never)} 这个动作`));
      }, lock.withPermits(1)),
      taskAct: Effect.fn("Tasks.taskAct")(function* (id, taskId, action, by) {
        const graph = yield* need(id);
        const task = taskOf(graph, taskId);
        if (!task) return yield* Effect.fail(missing(`计划里没有「${taskId}」这一步`, [lookIn.graph]));
        if (graph.state !== "running" && graph.state !== "paused") return yield* Effect.fail(refused("计划" + graphStateText[graph.state], graphNext(graph)));
        switch (action) {
          case "retry": {
            if (task.state !== "failed") return yield* Effect.fail(refused("「" + task.title + "」没有失败，不用重试", stepNext(graph, task)));
            const session = task.session ? live.sessionOf(task.session) : undefined;
            if (session && !isBusy(session)) {
              // Its session is still there: it goes on in the same session, with the (perhaps changed) job.
              yield* put(
                withTask(graph, task.id, (n) => ({ ...n, state: "working", tries: 0 })),
                by,
              );
              yield* tell(session.id, retryText(task) + "\n\n这一步的工单：\n" + task.brief);
              return session.name + " 接着做「" + task.title + "」";
            }
            yield* put(
              withTask(graph, task.id, (n) => ({ ...unmanned(n), state: "waiting", tries: 0 })),
              by,
            );
            yield* recurrence(graph.id);
            return "「" + task.title + "」重新排上了";
          }
          case "skip": {
            if (task.state !== "waiting" && task.state !== "failed")
              return yield* Effect.fail(
                refused(task.state === "working" ? "「" + task.title + "」正在做，先叫停" : "「" + task.title + "」已经做完了", stepNext(graph, task)),
              );
            let next = withTask(graph, task.id, (n) => ({ ...unmanned(n), state: "skipped" }));
            if (allSettled(next)) next = withNote({ ...next, state: "ready" }, "");
            yield* put(next, by);
            if (task.session) yield* dismiss(task.session);
            yield* recurrence(graph.id);
            return "跳过了「" + task.title + "」，后面的步骤照常开工";
          }
        }
        return yield* Effect.fail(refused(`不认识 ${String(action satisfies never)} 这个动作`));
      }, lock.withPermits(1)),
      editTask: (id, task, edit, by) => edited(id, (g) => editTask(g, task, edit), by),
      removeTask: (id, task, by) => edited(id, (g) => removeTask(g, task), by),
      previewRemoveTask: Effect.fn("Tasks.previewRemoveTask")(function* (id, task) {
        const graph = yield* need(id);
        const result = removeTask(graph, task);
        if (!result.ok) return yield* Effect.fail(refused(result.problem));
        const gone = taskOf(graph, task)!;
        const waiting = graph.tasks.filter((n) => n.needs.includes(task)).map((n) => `「${n.title}」`);
        return {
          does: [`从计划「${graph.title}」删掉「${gone.title}」这一步`, ...(waiting.length > 0 ? [`${waiting.join("、")}不再等它`] : [])],
        };
      }),
      events: Effect.fn("Tasks.events")(function* (id) {
        const rows = yield* db(q.graphEvents({ graph_id: id, n: readLimit }));
        const graph = get(id);
        const titleOf = (node: string) => (graph ? (taskOf(graph, node)?.title ?? node) : node);
        return rows.flatMap((row): GraphEvent[] => {
          // A row this code no longer knows how to read is left out.
          if (!(GraphEventKindValues as readonly string[]).includes(row.kind) || !(GraphActorValues as readonly string[]).includes(row.actor)) return [];
          const p = jsonOrNone(EventPayloadSchema)(row.payload) ?? {};
          const e: GraphEvent = {
            id: row.id,
            graph: row.graph_id,
            ...(row.task_id ? { task: row.task_id } : {}),
            kind: row.kind as GraphEventKind,
            actor: row.actor as GraphActor,
            ...(p.session ? { session: p.session } : {}),
            ...(p.detail ? { detail: p.detail } : {}),
            ...(p.changes ? { changes: p.changes } : {}),
            ...(p.commits ? { commits: p.commits } : {}),
            at: row.created_at,
          };
          return [{ ...e, text: graphEventText(changeOf(e), titleOf), actorText: actorText[e.actor] }];
        });
      }),
      changes: Effect.fn("Tasks.changes")(function* (id) {
        const graph = yield* need(id);
        if (!graph.branch) return yield* Effect.fail(refused("计划「" + graph.title + "」还没开工，没有分支"));
        const changes = yield* projects.branchChanges(graph.project, graph.branch).pipe(Effect.mapError((e) => refused(e.message)));
        if (!changes) return yield* Effect.fail(refused("计划「" + graph.title + "」的分支不在了：先确认它是不是被删掉了"));
        return changes;
      }),
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    };
    return shape;
  });

export const layer = (options?: TaskOptions) => Layer.effect(Tasks, make(options));

/** Issues' startup: the task graphs come back. */
export const start = Layer.effectDiscard(Effect.flatMap(Tasks, (t) => t.comeBack));
