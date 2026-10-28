// The one table the board, the command line, the orchestrator's tools and the server's refusals go by. reduce works it
// out with each issue's status and attention (withIssueStatuses), so a round that ends changes what the issue may do at
// once, wherever it is read.

import { issueWording } from "./words.ts";
import { wording } from "@vibevalley/protocol/words";
import { type Issue, type IssueStatus, IssueStatusValues } from "@vibevalley/protocol";
import { commandOf, type Next } from "@vibevalley/protocol/api";

/** in_progress and in_review are the session's to reach, never the owner's. */
export type Move =
  | "none"
  /** backlog → todo: sent out now, or waits in todo for room */
  | "start"
  /** todo → backlog */
  | "unqueue"
  /** in_review → todo: another round, with the owner's words (the findings, while it waits for acceptance), or with the
   * server's own for why it is stuck */
  | "round"
  /** done, canceled → todo: its doer takes it up again (a new session, or the orchestrator), with the owner's words */
  | "reopen"
  /** canceled before it was ever sent → backlog */
  | "revive"
  /** in_review → done: accepted, and delivered as the issue says (merged or by a pull request, kept on its branch, an answer) */
  | "complete"
  /** in_progress, in_review → canceled: its session, if any, goes home */
  | "cancel"
  /** backlog, todo → canceled: never sent */
  | "drop";

/** The whole table; the reason says why when there is no move. */
export function statusMove(issue: Issue, to: IssueStatus): [Move, string] {
  const from = issue.status;
  if (issue.graph || issue.task || issue.delivered === "merged_into_parent") return ["none", issueWording().move.inGraph];
  if (from === to) return ["none", issueWording().move.same];
  if (to === "in_progress" || to === "in_review") return ["none", issueWording().move.byHelpers];
  // Run before: by a session, or by an in-process agent (the orchestrator), whoever it was.
  const sent = issue.sessions.length > 0 || issue.lastRun !== undefined;
  switch (from) {
    case "backlog":
      if (to === "todo") return issue.refining ? ["none", issueWording().move.drafting(issue.refining.name)] : ["start", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "todo":
      if (to === "backlog") return ["unqueue", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "in_progress":
      return to === "canceled" ? ["cancel", ""] : ["none", issueWording().move.working];
    case "in_review":
      if (to === "todo") return ["round", ""];
      // A round that failed is never done: done is what was asked for, not how the round ended.
      if (to === "done") return issue.attention.stuck === "failed" ? ["none", issueWording().move.failed] : ["complete", ""];
      if (to === "canceled") return ["cancel", ""];
      break;
    case "done":
    case "canceled":
      if (to === "todo" && sent) return ["reopen", ""];
      if (to === "backlog" && !sent) return ["revive", ""];
      return sent ? ["none", issueWording().move.reopen] : ["none", issueWording().move.revive];
  }
  return ["none", issueWording().move.cannot(wording().status[from], wording().status[to])];
}

export const statusMoves = (issue: Issue): IssueStatus[] => IssueStatusValues.filter((to) => statusMove(issue, to)[0] !== "none");

/** One that needs the owner's words runs nothing and says which field takes them. */
export function nextSteps(item: Issue): Next[] {
  const n = String(item.number);
  const session = item.sessions.at(-1);
  const acts = item.attention.acts.flatMap((a): Next[] => {
    const label = wording().act[a.act];
    switch (a.does) {
      case "move":
        return a.words === "required"
          ? [{ say: issueWording().move.roundWithText(label, commandOf("issue.status.update", [n]).join(" "), a.status) }]
          : [{ say: label, run: commandOf("issue.status.update", [n], { status: a.status }) }];
      case "say":
        return [{ say: issueWording().move.sayWithText(label, commandOf("issue.comment.create", [n]).join(" ")) }];
      case "stop":
        return session === undefined ? [] : [{ say: label, run: commandOf("session.stop", [session]) }];
    }
  });
  const pressed = new Set(item.attention.acts.flatMap((a) => (a.does === "move" ? [a.status] : [])));
  const moves = statusMoves(item)
    .filter((to) => !pressed.has(to))
    .map((to): Next => {
      const say = issueWording().move.moveTo(wording().status[to]);
      return statusMove(item, to)[0] === "round"
        ? { say: issueWording().move.roundWithText(say, commandOf("issue.status.update", [n]).join(" "), to) }
        : { say, run: commandOf("issue.status.update", [n], { status: to }) };
    });
  return [...acts, ...moves];
}
