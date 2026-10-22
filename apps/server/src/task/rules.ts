// A task graph's own rules: reading one from a splitter's answer, editing its steps, what
// each step is told, and which steps start.

import {
  type Agent,
  type WorkspaceState,
  type GraphEvent,
  type GraphState,
  type Issue,
  type IssueClose,
  type Session,
  type Task,
  type TaskEdit,
  type TaskGraph,
} from "@vibevalley/protocol";
import { isForManager } from "../issue/state.ts";
import { slice } from "../base/text.ts";
import { blockedBy, canEditTask, canRemoveTask, graphProblems, graphStateText, isAcceptance, isSettled, maxTasks, taskOf, taskStateText } from "./graph.ts";
import { graphFrom } from "./issues.ts";

/** The farm's limits come on top. */
export function startable(graph: TaskGraph): Task[] {
  const working = graph.tasks.filter((n) => n.state === "working").length;
  return readyTasks(graph).slice(0, Math.max(0, graph.parallel - working));
}

export const allSettled = (graph: TaskGraph) => graph.tasks.length > 0 && graph.tasks.every(isSettled);

function frozenOf(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  for (const n of acceptancesOf(graph, task)) for (const f of n.frozen ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

export const frozenTouched = (graph: TaskGraph, task: Task, changed: readonly string[]) => {
  const frozen = frozenOf(graph, task);
  return changed.filter((f) => frozen.includes(f));
};

/** A step as whoever splits writes it: the splitting session in its json block, a helper through issue_split. */
export interface StepDraft {
  readonly id: string;
  readonly title?: string;
  readonly brief: string;
  readonly needs?: readonly string[];
  readonly agent?: string;
  readonly check?: string;
  readonly scope?: readonly string[];
  readonly acceptance?: boolean;
}

export function freshTask(draft: StepDraft): Task {
  const id = draft.id.trim();
  const agent = (draft.agent ?? "").trim();
  const check = (draft.check ?? "").trim();
  return {
    id,
    title: (draft.title ?? "").trim() || id,
    brief: draft.brief.trim(),
    needs: (draft.needs ?? []).map((x) => x.trim()),
    ...(agent ? { agent } : {}),
    ...(check ? { check } : {}),
    ...(draft.scope && draft.scope.length > 0 ? { scope: [...draft.scope] } : {}),
    ...(draft.acceptance ? { acceptance: true } : {}),
    state: "waiting",
    tries: 0,
  };
}

export type ParsedSplit = { readonly ok: true; readonly title?: string; readonly tasks: Task[] } | { readonly ok: false; readonly problems: string[] };

const taskBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** JSON as Go's decoder reads it; the words for one that does not read say what Go's would where they are the same failure. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(body.trim() === "" || /end of JSON input/i.test(message) ? "unexpected end of JSON input" : message);
  }
}

/** Optional fields may be missing but never null; other keys are ignored. */
function decodeSplitDraft(raw: unknown): { title?: string; tasks: StepDraft[] } | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "要一个对象";
  const obj = raw as Record<string, unknown>;
  let title: string | undefined;
  if ("title" in obj) {
    if (typeof obj.title !== "string") return `["title"] 要是字符串`;
    title = obj.title;
  }
  if (!Array.isArray(obj.tasks)) return `["tasks"] 要是数组`;
  const tasks: StepDraft[] = [];
  for (const [i, item] of obj.tasks.entries()) {
    const at = `["tasks"][${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return at + " 要是对象";
    const o = item as Record<string, unknown>;
    const text = (key: string, required: boolean): string | undefined | { problem: string } => {
      if (!(key in o)) return required ? { problem: `${at}["${key}"] 缺了` } : undefined;
      return typeof o[key] === "string" ? o[key] : { problem: `${at}["${key}"] 要是字符串` };
    };
    const texts = (key: string): string[] | undefined | { problem: string } => {
      if (!(key in o)) return undefined;
      const a = o[key];
      if (!Array.isArray(a)) return { problem: `${at}["${key}"] 要是数组` };
      const bad = a.findIndex((x) => typeof x !== "string");
      return bad >= 0 ? { problem: `${at}["${key}"][${bad}] 要是字符串` } : (a as string[]);
    };
    const step: Record<string, unknown> = {};
    for (const [key, read] of [
      ["id", () => text("id", true)],
      ["title", () => text("title", false)],
      ["brief", () => text("brief", true)],
      ["needs", () => texts("needs")],
      ["agent", () => text("agent", false)],
      ["check", () => text("check", false)],
      ["scope", () => texts("scope")],
    ] as const) {
      const v = read();
      if (v !== undefined && typeof v === "object" && !Array.isArray(v)) return v.problem;
      if (v !== undefined) step[key] = v;
    }
    if ("acceptance" in o) {
      if (typeof o.acceptance !== "boolean") return at + `["acceptance"] 要是布尔值`;
      step.acceptance = o.acceptance;
    }
    tasks.push(step as unknown as StepDraft);
  }
  return { ...(title !== undefined ? { title } : {}), tasks };
}

export function parseSplit(text: string): ParsedSplit {
  const blocks = [...text.matchAll(taskBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { ok: false, problems: ["没找到计划：要用一个 json 代码块给出"] };
  let last = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let raw: unknown;
    try {
      raw = parseJson(blocks[i]!);
    } catch (e) {
      last = "json 读不了：" + (e as Error).message;
      continue;
    }
    const draft = decodeSplitDraft(raw);
    if (typeof draft === "string") {
      last = "计划的格式不对：" + draft;
      continue;
    }
    const tasks = draft.tasks.map(freshTask);
    const problems = graphProblems(tasks);
    if (problems.length > 0) return { ok: false, problems };
    const title = (draft.title ?? "").trim();
    return { ok: true, ...(title ? { title } : {}), tasks };
  }
  return { ok: false, problems: [last] };
}

export type EditResult = { readonly ok: true; readonly graph: TaskGraph } | { readonly ok: false; readonly problem: string };

const checked = (graph: TaskGraph): EditResult => {
  const problems = graphProblems(graph.tasks);
  return problems.length > 0 ? { ok: false, problem: problems[0]! } : { ok: true, graph };
};

/** needs and scope count as given when there, as an empty JSON array decodes. */
export function editTask(graph: TaskGraph, id: string, edit: TaskEdit): EditResult {
  const task = taskOf(graph, id);
  if (!canEditTask(graph, task))
    return {
      ok: false,
      problem: task ? "「" + task.title + "」" + taskStateText[task.state] + "，不能改了" : "计划" + graphStateText[graph.state] + "，不能加步骤了",
    };
  const base: Task = task ?? { id, title: id, brief: "", needs: [], state: "waiting", tries: 0 };
  const agent = edit.agent !== undefined ? edit.agent.trim() : base.agent;
  const check = edit.check !== undefined ? edit.check.trim() : base.check;
  const scope = edit.scope !== undefined ? edit.scope : base.scope;
  const { agent: _a, check: _c, scope: _s, ...rest } = base;
  const next: Task = {
    ...rest,
    ...(edit.title !== undefined ? { title: edit.title.trim() || id } : {}),
    ...(edit.brief !== undefined ? { brief: edit.brief.trim() } : {}),
    ...(edit.needs !== undefined ? { needs: [...edit.needs] } : {}),
    ...(agent ? { agent } : {}),
    ...(check ? { check } : {}),
    ...(scope && scope.length > 0 ? { scope: [...scope] } : {}),
  };
  if (task) return checked(withTask(graph, id, () => next));
  return checked({ ...graph, tasks: [...graph.tasks, next] });
}

export function removeTask(graph: TaskGraph, id: string): EditResult {
  const task = taskOf(graph, id);
  if (!task) return { ok: false, problem: "计划里没有「" + id + "」这一步" };
  if (!canRemoveTask(graph, task)) return { ok: false, problem: "「" + task.title + "」" + taskStateText[task.state] + "，不能删了：可以跳过它" };
  return checked({ ...graph, tasks: graph.tasks.filter((n) => n.id !== id).map((n) => ({ ...n, needs: n.needs.filter((x) => x !== id) })) });
}

/** What a step's session is told: the task graph, its job, what came before it, and how it is judged. */
export function taskBrief(graph: TaskGraph, task: Task): string {
  const index = graph.tasks.findIndex((n) => n.id === task.id) + 1;
  const lines = [
    `这是种植计划「${graph.title}」里的一步：${task.title}（步骤 ${task.id}，第 ${index}/${graph.tasks.length} 步）。`,
    "整个计划要做的：" + graph.goal,
    "",
    "你这一步的工单：",
    task.brief,
  ];
  if (task.scope && task.scope.length > 0) lines.push("", "只改这些地方：" + task.scope.join("、") + "。别的步骤可能同时在改别处。");
  const before = task.needs.flatMap((id) => {
    const n = taskOf(graph, id);
    return n ? [n] : [];
  });
  if (before.length > 0) {
    lines.push("", "前面已经做完、合进你分支里的步骤：");
    for (const n of before) {
      const commits = n.commits && n.commits.length > 0 ? "（" + n.commits.join("、") + "）" : "";
      const said = n.state === "skipped" ? "跳过了，没有做" : (n.conclusion ?? "做完了");
      lines.push("- " + n.title + commits + "：" + said);
    }
  }
  if (isAcceptance(task)) {
    lines.push(
      "",
      "这是一步验收：只写能复现问题、或说明要做成什么样的测试，不要去修、去实现。",
      "做完以后会在你的分支上跑 `" + (task.check ?? "") + "`，它这时要**不通过**：通过了就说明它没抓住问题。",
      "你留下的文件会冻结，后面的步骤不能改；收尾的那步要让它通过。",
    );
  } else if (task.check) lines.push("", "做完以后会在你的分支上跑 `" + task.check + "`，要能通过。");
  const frozen = frozenOf(graph, task);
  if (frozen.length > 0) lines.push("", "前面的验收留下的这些文件是冻结的，不能改：" + frozen.join("、") + "。验收不过就改代码，不改验收。");
  const checks = acceptanceChecks(graph, task);
  if (checks.length > 0) lines.push("", "你是收尾的一步：做完以后还会跑前面的验收，要能通过：" + checks.map((c) => "`" + c + "`").join("、") + "。");
  lines.push("", "做完提交。农场会把你的分支合回计划分支，给后面的步骤用；结论里写清楚你留下了什么（接口、文件位置），后面的步骤要接着用。");
  return lines.join("\n");
}

export const checkFailedText = (check: string, output: string) =>
  "做完以后跑 `" + check + "` 没通过，输出的结尾：\n" + (output.trim() || "（没有输出）") + "\n\n修好，再提交。";

export const acceptancePassedText = (check: string) =>
  "验收写好了，可 `" + check + "` 现在就通过了：它没抓住要修的问题，或要做的事。改成现在会失败的验收，再提交；别去修问题本身。";

export const frozenTouchedText = (files: readonly string[]) =>
  "你改了前面的验收留下的文件：" + files.join("、") + "。验收是冻结的：把它们恢复成计划分支上的样子，从代码上修，再提交。";

export const retryText = (task: Task) => "上一轮没做成。看一下报错，接着把这一步做完：" + task.title + "。";

export const changeOf = (e: GraphEvent) => ({
  graph: e.graph,
  ...(e.task !== undefined ? { task: e.task } : {}),
  kind: e.kind,
  ...(e.session !== undefined ? { session: e.session } : {}),
  ...(e.detail !== undefined ? { detail: e.detail } : {}),
  ...(e.changes !== undefined ? { changes: e.changes } : {}),
  ...(e.commits !== undefined ? { commits: e.commits } : {}),
});

/** Only the helper an issue was last sent to splits it, and only while it is a plain open issue. */
export function issueSplitRefusal(session: Session | undefined, issue: Issue | undefined): string {
  if (!session) return "你已经不在地里了";
  if (session.graph) return "你在做计划里的一步：这一步不能再拆，太大就在结论里说，让主人改计划";
  if (!issue) return "你手上没有工单：只有工单能拆";
  if (session.refining) return "你在起草这张工单，还没开工：把要拆的想法写进草稿";
  if (issue.graph || issue.task) return "这张工单已经是计划了";
  if (issue.closed !== undefined || issue.closedAt !== undefined) return "这张工单已经关了";
  if (isForManager(issue)) return "这是派给管家的工单";
  if (!issue.project) return "这张工单没有项目，没法开分支";
  if (issue.sessions.length === 0 || issue.sessions.at(-1) !== session.id) return "这张工单现在不归你做";
  if (!session.branch) return "你直接在项目里干活，没有自己的分支：拆了没处开计划的分支";
  return "";
}

export const taskIssueID = (graph: string, key: string) => graph + "." + key;

/** What only the issues know (their runs, priority, when they were written down and closed) comes from before; one closing now closes at now. */
export function graphIssues(graph: TaskGraph, before: readonly Issue[], now: number): Issue[] {
  const was = new Map(before.map((t) => [t.id, t]));
  const keep = (draft: Draft, closed: IssueClose | undefined): Issue => {
    const t = { ...draft, sessions: [], priority: "medium", createdAt: graph.createdAt } as unknown as Issue;
    const old = was.get(t.id);
    if (old) {
      Object.assign(t, { sessions: old.sessions, priority: old.priority, createdAt: old.createdAt, status: old.status });
      if (closed !== undefined && old.closedAt !== undefined) t.closedAt = old.closedAt;
    }
    t.sessions ??= [];
    t.closed = closed;
    if (closed !== undefined && t.closedAt === undefined) t.closedAt = now;
    return t;
  };
  const project = graph.project;
  const out = [
    keep(
      {
        id: graph.id,
        title: graph.title,
        description: graph.goal,
        project,
        // A helper's issue split under it keeps who it was given to.
        assignee: was.get(graph.id)?.assignee,
        graph: { state: graph.state, branch: graph.branch, parallel: graph.parallel, note: graph.note },
      },
      graphClosed(graph.state),
    ),
  ];
  (graph.tasks ?? []).forEach((n, i) => {
    const blocked = (n.needs ?? []).map((need) => taskIssueID(graph.id, need));
    out.push(
      keep(
        {
          id: taskIssueID(graph.id, n.id),
          title: n.title,
          description: n.brief,
          project,
          assignee: n.agent,
          rank: i > 0 ? i : undefined,
          parent: graph.id,
          blockedBy: blocked.length > 0 ? blocked : undefined,
          task: {
            key: n.id,
            state: n.state,
            check: n.check,
            scope: n.scope,
            acceptance: n.acceptance,
            frozen: n.frozen,
            session: n.session,
            conclusion: n.conclusion,
            commits: n.commits,
            spent: n.spent,
            tries: n.tries,
            failures: n.failures,
          },
        },
        taskClosed(graph.state, n),
      ),
    );
  });
  return out;
}

export function graphOf(state: WorkspaceState, id: string): TaskGraph | undefined {
  const issues = state.issues ?? [];
  const t = issues.find((t) => t.id === id && t.graph);
  return t ? graphFrom(t, issues) : undefined;
}

const graphClosed = (s: GraphState): IssueClose | undefined => (s === "done" ? "merged" : s === "abandoned" ? "dismissed" : undefined);

function taskClosed(graph: GraphState, n: Task): IssueClose | undefined {
  if (n.state === "merged") return "merged_into_graph";
  if (n.state === "skipped" || graph === "done" || graph === "abandoned") return "dismissed";
  return undefined;
}

type Draft = Omit<Issue, "number" | "priority" | "createdAt" | "sessions" | "status" | "moves" | "review" | "findings" | "questions" | "attention">;

export const defaultParallel = 3;

export const autoRetries = 2;

export const readyTasks = (graph: TaskGraph): Task[] =>
  graph.state !== "running" ? [] : (graph.tasks ?? []).filter((n) => n.state === "waiting" && blockedBy(graph, n).length === 0);

export const withTask = (graph: TaskGraph, id: string, change: (n: Task) => Task): TaskGraph => ({
  ...graph,
  tasks: (graph.tasks ?? []).map((n) => (n.id === id ? change(n) : n)),
});

export function ancestorsOf(graph: TaskGraph, task: Task): Task[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const need of taskOf(graph, id)?.needs ?? []) visit(need);
  };
  for (const need of task.needs ?? []) visit(need);
  return (graph.tasks ?? []).filter((n) => n.id !== task.id && seen.has(n.id));
}

export const acceptancesOf = (graph: TaskGraph, task: Task) => ancestorsOf(graph, task).filter((n) => isAcceptance(n) && n.state === "merged");

export const isLast = (graph: TaskGraph, task: Task) => !(graph.tasks ?? []).some((n) => (n.needs ?? []).includes(task.id));

export function acceptanceChecks(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  if (!isLast(graph, task)) return out;
  for (const n of acceptancesOf(graph, task)) if (n.check && !out.includes(n.check) && n.check !== task.check) out.push(n.check);
  return out;
}

export function graphText(graph: TaskGraph): string {
  const tasks = graph.tasks ?? [];
  const merged = tasks.filter(isSettled).length;
  let head = "「" + graph.title + "」（" + graph.id + "，项目 " + graph.project;
  if (graph.branch) head += "，分支 " + graph.branch;
  head += "）：" + graphStateText[graph.state];
  if (tasks.length > 0) head += `，${merged}/${tasks.length} 步做完`;
  if (graph.note) head += "。" + graph.note;
  const lines = [head];
  for (const n of tasks) {
    let detail = taskStateText[n.state];
    if (n.state === "waiting") {
      const waits = blockedBy(graph, n);
      if (waits.length > 0) detail = "等 " + waits.join("、");
    }
    let line = "  - " + n.id + " " + n.title + (isAcceptance(n) ? "（验收）" : "") + "：" + detail;
    if (n.session) line += "（帮工 " + n.session + "）";
    if (n.conclusion) line += "；" + slice(n.conclusion, 0, 80);
    lines.push(line);
  }
  return lines.join("\n");
}

/** What a splitter is told: split goal into a task graph, as JSON, for the profiles there are. */
export function splitBrief(goal: string, project: string, agents: readonly Agent[]): string {
  const agent = agents[0]?.id ?? "lab";
  const example = {
    title: "按月查询打卡记录",
    tasks: [
      { id: "accept", title: "验收", brief: "……", needs: [], scope: ["test/month.test.ts"], check: "pnpm test test/month.test.ts", acceptance: true },
      { id: "schema", title: "数据层", brief: "……", needs: ["accept"], scope: ["src/db"], check: "pnpm test" },
      { id: "api", title: "查询接口", brief: "……", needs: ["schema"], agent, scope: ["src/api"], check: "pnpm test" },
    ],
  };
  const lines = [
    "这一轮你是规划师：把下面这件事拆成一张种植计划，交给几个帮工分头去做。你自己不写代码、不改文件、不提交。",
    "",
    "要做的事：" + goal.trim(),
    `项目：${project}（你现在就在它的目录里）`,
    "",
    "先读代码，弄清现状，再拆。拆的规矩：",
    `- 最多 ${maxTasks} 步，一般三到六步。一步是一个帮工在自己的分支上能做完、提交、单独验证的一件事，不要拆得太碎。`,
    "- brief 是这一步的工单，写清：目标、要改哪里、做到什么程度算完、要留下什么给后面的步骤（接口签名、文件位置、数据格式）。帮工只看得到它自己这一步的工单和前面步骤的结论。",
    "- needs 写这一步要等哪些步骤做完。不互相依赖的步骤会同时做：尽量让它们改不同的文件，写在 scope 里。",
    "- 别拆成一条串行的长链（每一步都等上一步，就只能一个一个做）。有先后的按阶段分组，同一阶段里的步骤互不依赖。",
    "- 项目里有测试或构建命令的，写进 check（比如 pnpm test），这一步做完会在它的分支上跑，过了才合。",
    "- 修 bug，或要做的事能用测试说清楚的：第一步写验收（acceptance: true）。它只写现在会失败的测试（复现 bug，或说明做成什么样），不修、不实现；check 写只跑这些测试的命令，要因为问题本身失败，不能因为写错、编译不过失败。别的步骤都等它。它合进去以后就冻结了，后面的步骤不能改它，最后一步要让它通过。",
    "- 最后放一步整体验证：跑全部测试、修小问题、补文档，写一段总结。",
    "- id 用简短的英文小写单词，比如 schema、api、ui。",
  ];
  if (agents.length > 0) {
    lines.push("- 能派的帮工（agent 填 id；不填就按「适合的活」挑）：");
    for (const a of agents) {
      // 职责 is the profile's role; 适合的活 its tags, which chooseAgent matches.
      const about = [...(a.role ? ["职责：" + a.role] : []), ...((a.tags ?? []).length > 0 ? ["适合的活：" + a.tags!.join("、")] : [])];
      lines.push(`  - ${a.id}：${a.name}，${about.join("；")}`);
    }
  }
  lines.push(
    "",
    "汇报的最后，用一个 json 代码块给出整张计划，格式照这个：",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "代码块之后写一句结论：拆成了几步、为什么这样拆。",
  );
  return lines.join("\n");
}
