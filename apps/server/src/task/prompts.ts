// What the task graphs say to models: the splitter's brief, a step's job and what its helper is told when it is sent
// back, the orchestrator's news of a task graph and the lines it reads one by, and the refusals of the tools only models call.
// In Chinese whatever the owner's locale: the models answer in the owner's.

import type { Agent, Issue, Session, Task, TaskGraph, GraphState, TaskState } from "@vibevalley/protocol";
import { traitsOf } from "@/agent/prompts.ts";
import { slice } from "@/base/clip.ts";
import { isForOrchestrator } from "@/issue/state.ts";
import { blockedBy, isAcceptance, isSettled, maxTasks, taskOf } from "./graph.ts";
import { acceptanceChecks, frozenOf } from "./rules.ts";

/** A graph's and a step's state as the model reads them (only in Chinese: prompts are). */
const graphStateText: Record<GraphState, string> = {
  splitting: "在拆",
  draft: "等你看过再开工",
  running: "在做",
  paused: "暂停了",
  ready: "都做完了，等你合进主分支",
  done: "合进了主分支",
  abandoned: "放弃了",
};
const taskStateText: Record<TaskState, string> = { waiting: "等着", working: "在做", merged: "合进去了", failed: "没做成", skipped: "跳过了" };
export const startNeedsOwner = "计划开工要主人点头。这一轮不是主人叫你的：把拆好的计划给主人看，问要不要开工。";
export const mergeNeedsOwner = "合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。";

/** What the orchestrator hears of a task graph, after its 【计划】. */
export const graphNews = {
  head: "【计划】",
  notSplit: (id: string, title: string, why: string) => id + "「" + title + "」没拆成：" + why + "。问主人要不要换个说法再拆。",
  drafted: (id: string, graph: string) => id + " 拆好了，等主人看过再开工（graph_act start）。用一两句话告诉主人拆成了哪几步。\n" + graph,
  stepFailed: (id: string, title: string, step: string, stepId: string, why: string) =>
    id +
    "「" +
    title +
    "」的「" +
    step +
    "」（" +
    stepId +
    "）没做成：" +
    why +
    "。它后面的步骤在等；问主人是重试（graph_task_act retry）、改工单，还是跳过（graph_task_act skip）。",
  ready: (id: string, title: string, graph: string) =>
    id + "「" + title + "」都做完了，等主人合进主分支（graph_act merge）。用两三句话告诉主人做成了什么。\n" + graph,
  split: (name: string, id: string, n: number, graph: string) => `${name} 把工单 ${id} 拆成了 ${n} 步，直接开工了。\n${graph}`,
};

/** What the splitter and a step's helper are told along the way. */
export const graphTell = {
  retrySplit: "上一轮没做成。看一下报错，接着把计划拆完，最后用 json 代码块给出。",
  fixGraph: (problems: readonly string[]) =>
    "计划有问题：\n" + problems.map((x) => "- " + x).join("\n") + "\n\n改好，在最后用一个 json 代码块重新给出整张计划。",
  carryOn: (title: string) => "接着把这一步做完：" + title,
  retry: (text: string, brief: string) => text + "\n\n这一步的工单：\n" + brief,
  /** graph_split's answer to the helper that split its issue. */
  split: (title: string, n: number, branch: string) =>
    `拆好了：工单「${title}」下面 ${n} 张子工单，在分支 ${branch} 上开工了，每一步派给一个帮工。你这张工单的活交给它们了：别再改代码，用一两句话汇报拆成了哪几步，这一轮就结束，汇报完你就收工。`,
};

/** What a splitter's job is matched against the profiles' tags by (chooseAgent). */
export const graphMatch = (goal: string) => "规划 计划 拆分 " + goal;

/** What a step's session is told: the task graph, its job, what came before it, and how it is judged. */
export function taskBrief(graph: TaskGraph, task: Task): string {
  const index = graph.tasks.findIndex((n) => n.id === task.id) + 1;
  const lines = [
    `这是计划「${graph.title}」里的一步：${task.title}（步骤 ${task.id}，第 ${index}/${graph.tasks.length} 步）。`,
    "整个计划要做的：" + graph.goal,
    "",
    "你这一步的工单：",
    task.brief,
  ];
  if (task.scope.length > 0) lines.push("", "只改这些地方：" + task.scope.join("、") + "。别的步骤可能同时在改别处。");
  const before = task.needs.flatMap((id) => {
    const n = taskOf(graph, id);
    return n ? [n] : [];
  });
  if (before.length > 0) {
    lines.push("", "前面已经做完、合进你分支里的步骤：");
    for (const n of before) {
      const commits = n.commits.length > 0 ? "（" + n.commits.join("、") + "）" : "";
      const said = n.state === "skipped" ? "跳过了，没有做" : n.conclusion || "做完了";
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
  lines.push("", "做完提交。VibeValley 会把你的分支合回计划分支，给后面的步骤用；结论里写清楚你留下了什么（接口、文件位置），后面的步骤要接着用。");
  return lines.join("\n");
}

export const checkFailedText = (check: string, output: string) =>
  "做完以后跑 `" + check + "` 没通过，输出的结尾：\n" + (output.trim() || "（没有输出）") + "\n\n修好，再提交。";

export const acceptancePassedText = (check: string) =>
  "验收写好了，可 `" + check + "` 现在就通过了：它没抓住要修的问题，或要做的事。改成现在会失败的验收，再提交；别去修问题本身。";

export const frozenTouchedText = (files: readonly string[]) =>
  "你改了前面的验收留下的文件：" + files.join("、") + "。验收是冻结的：把它们恢复成计划分支上的样子，从代码上修，再提交。";

export const retryText = (task: Task) => "上一轮没做成。看一下报错，接着把这一步做完：" + task.title + "。";

/** Only the helper an issue was last sent to splits it, and only while it is a plain open issue. */
export function issueSplitRefusal(session: Session | undefined, issue: Issue | undefined, orchestrator: (id: string) => boolean): string {
  if (!session) return "你已经不在场了";
  if (session.graph) return "你在做计划里的一步：这一步不能再拆，太大就在结论里说，让主人改计划";
  if (!issue) return "你手上没有工单：只有工单能拆";
  if (session.refining) return "你在起草这张工单，还没开工：把要拆的想法写进草稿";
  if (issue.graph || issue.task) return "这张工单已经是计划了";
  if (issue.closedAt !== undefined) return "这张工单已经关了";
  if (isForOrchestrator(issue, orchestrator)) return "这是派给管家的工单";
  if (!issue.project) return "这张工单没有项目，没法开分支";
  if (issue.sessions.length === 0 || issue.sessions.at(-1) !== session.id) return "这张工单现在不归你做";
  if (!session.branch) return "你直接在项目里干活，没有自己的分支：拆了没处开计划的分支";
  return "";
}

export function graphText(graph: TaskGraph): string {
  const tasks = graph.tasks;
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
    "这一轮你是规划师：把下面这件事拆成一张计划，交给几个帮工分头去做。你自己不写代码、不改文件、不提交。",
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
      lines.push(`  - ${a.id}：${a.name}，${traitsOf(a)}`);
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
