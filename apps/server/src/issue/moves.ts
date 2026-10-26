// Where an issue may be moved, and what each move does: the table the board, the command line, the orchestrator's tools and
// the server's refusals all go by. Worked out with the issue's status and attention in reduce (withIssueStatuses), so a
// round that ends changes what the issue may do at once, wherever it is read.

import { wording } from "@vibevalley/protocol/words";
import { type Issue, type IssueAct, type IssueStatus, IssueStatusValues } from "@vibevalley/protocol";
import type { Next } from "@vibevalley/protocol/api";

/** What moving an issue to a status does. in_progress and in_review are the session's to reach, never the owner's. */
export type Move =
  | "none"
  /** backlog → todo: sent out now, or waits in todo for room */
  | "start"
  /** todo → backlog */
  | "unqueue"
  /** in_review → todo: another round, with the owner's words */
  | "round"
  /** done, canceled → todo: its doer takes it up again (a new session, or the orchestrator), with the owner's words */
  | "reopen"
  /** canceled before it was ever sent → backlog */
  | "revive"
  /** in_review → done: what it delivers follows the issue (its branch's commits, the owner's choice to keep it) */
  | "complete"
  /** in_progress, in_review → canceled: its session, if any, goes home */
  | "cancel"
  /** backlog, todo → canceled: never sent */
  | "drop";

/** The whole table; the reason says why when there is no move. */
export function statusMove(t: Issue, to: IssueStatus): [Move, string] {
  const from = t.status;
  if (t.graph || t.task || t.delivered === "merged_into_parent") return ["none", "这是计划里的工单，跟着计划走：在计划里改"];
  if (from === to) return ["none", "它已经是这个状态了"];
  if (to === "in_progress" || to === "in_review") return ["none", "处理中和等你看是帮工干出来的：挪到待办，它就开工"];
  // Run before: by a session, or by an in-process agent (the orchestrator), whoever it was.
  const sent = t.sessions.length > 0 || t.lastRun !== undefined;
  switch (from) {
    case "backlog":
      if (to === "todo") return t.refining ? ["none", t.refining.name + " 正在起草：等它交回来再开工"] : ["start", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "todo":
      if (to === "backlog") return ["unqueue", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "in_progress":
      return to === "canceled" ? ["cancel", ""] : ["none", "还在干这一轮：等它交回来，或者挪到已取消"];
    case "in_review":
      if (to === "todo") return ["round", ""];
      // Every issue has an acceptance; a glance one is passed by completing itself, so a round that failed is never
      // completed: done is what was asked for, not how the round ended.
      if (to === "done") {
        if (t.attention.stuck === "failed") return ["none", "这一轮没做成：带句话再干一轮，或者关掉"];
        return t.review === "required" && t.reviewedAt === undefined ? ["none", "这张工单要先过验收：验收通过才能完成"] : ["complete", ""];
      }
      if (to === "canceled") return ["cancel", ""];
      break;
    case "done":
    case "canceled":
      if (to === "todo" && sent) return ["reopen", ""];
      if (to === "backlog" && !sent) return ["revive", ""];
      return sent ? ["none", "关上的工单挪回待办，就是带一句话重开"] : ["none", "没开过工就取消的工单，挪回备选再说"];
  }
  return ["none", "不能从" + wording().status[from] + "挪到" + wording().status[to]];
}

export const statusMoves = (t: Issue): IssueStatus[] => IssueStatusValues.filter((to) => statusMove(t, to)[0] !== "none");

/** The acts that need the owner's words (a question's answer, a word to the helper, what failed, what to do again). */
const wordy: ReadonlySet<IssueAct> = new Set(["answer", "tell", "reject", "reopen"]);

/** What the issue can be asked for now, as next steps after a refusal: each of its acts (attention.acts) and moves, as the
 * command for it. One that needs the owner's words says which field takes them and has no command to run as it is. */
export function nextSteps(t: Issue): Next[] {
  const n = String(t.number);
  const acts = t.attention.acts.map((act): Next => {
    const label = wording().act[act];
    return wordy.has(act)
      ? { say: `${label}：issue act ${n}，--json 带 act「${act}」和要说的 text` }
      : { say: label, run: ["issue", "act", n, "--json", JSON.stringify({ act })] };
  });
  const moves = statusMoves(t).map((to): Next => {
    const say = "挪到" + wording().status[to];
    return statusMove(t, to)[0] === "round"
      ? { say: `${say}：issue status ${n}，--json 带 status「${to}」和这一轮要它做什么的 text` }
      : { say, run: ["issue", "status", n, "--json", JSON.stringify({ status: to })] };
  });
  return [...acts, ...moves];
}
