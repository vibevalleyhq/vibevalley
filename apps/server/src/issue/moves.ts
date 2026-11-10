import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues } from "@vibevalley/protocol";
import { actCommand, type Next } from "@vibevalley/protocol/api";
import { executionsOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

/** in_progress and in_review are the session's to reach, never the user's. */
export type Move =
  | "none"
  /** backlog → todo: sent out now, or waits in todo for room */
  | "start"
  /** todo → backlog */
  | "unqueue"
  /** in_review → todo: another round, with the user's words (the findings, while it waits for acceptance), or with the
   * server's own for why it is stuck */
  | "round"
  /** done, canceled → todo: its doer takes it up again (a new session, or the orchestrator), with the user's words */
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
export function statusMove(issue: T.Issue, to: T.IssueStatus): [Move, string] {
  const from = issue.status;
  if (issue.delivered === "merged_into_parent") return ["none", t("server.issue.move.inGraph")];
  if (from === to) return ["none", t("server.issue.move.same")];
  if (to === "in_progress" || to === "in_review") return ["none", t("server.issue.move.byHelpers")];
  // Run before: by a session, or by an in-process agent (the orchestrator), whoever it was.
  const sent = executionsOf(issue).length > 0 || issue.lastRun !== undefined;
  switch (from) {
    case "backlog":
      if (to === "todo") return issue.refining ? ["none", t("server.issue.move.drafting", { name: issue.refining.name })] : ["start", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "todo":
      if (to === "backlog") return ["unqueue", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "in_progress":
      if (to === "done" && issue.stage.stuck === "failed") return ["none", t("server.issue.move.failed")];
      if (to === "todo" && (issue.stage.state === "asking" || (issue.stage.state === "stuck" && issue.stage.stuck !== "quiet"))) return ["round", ""];
      if (to === "done" && issue.stage.stuck === "interrupted") return ["complete", ""];
      return to === "canceled" ? ["cancel", ""] : ["none", t("server.issue.move.working")];
    case "in_review":
      if (to === "todo") return ["round", ""];
      // A round that failed is never done: done is what was asked for, not how the round ended.
      if (to === "done") return issue.stage.stuck === "failed" ? ["none", t("server.issue.move.failed")] : ["complete", ""];
      if (to === "canceled") return ["cancel", ""];
      break;
    case "done":
    case "canceled":
      if (to === "todo" && sent) return ["reopen", ""];
      if (to === "backlog" && !sent) return ["revive", ""];
      return sent ? ["none", t("server.issue.move.reopen")] : ["none", t("server.issue.move.revive")];
  }
  return ["none", t("server.issue.move.cannot", { from: t(`shared.status.${from}`), to: t(`shared.status.${to}`) })];
}

export const statusMoves = (issue: T.Issue): T.IssueStatus[] => IssueStatusValues.filter((to) => statusMove(issue, to)[0] !== "none");

/** One that needs the user's words runs nothing and says which field takes them. */
export function nextSteps(item: T.Issue): Next[] {
  const n = String(item.number);
  const session = latestSessionIdOf(item);
  const acts = item.stage.acts.flatMap((a): Next[] => {
    const label = t(`shared.act.${a.act}`);
    const command = actCommand(item, a, session);
    if (command === undefined) return [];
    // One that needs the user's words runs nothing: it says the command, and where the words go.
    if (command.words === "required")
      return [
        {
          say: t("server.issue.move.withWords", {
            say: label,
            command: [...command.run, ...(a.does === "move" ? ["--comment", "…"] : ["…"])].join(" "),
          }),
        },
      ];
    return [{ say: label, run: [...command.run] }];
  });
  const pressed = new Set(item.stage.acts.flatMap((a) => (a.does === "move" ? [a.status] : [])));
  const moves = statusMoves(item)
    .filter((to) => !pressed.has(to))
    .map((to): Next => {
      const say = t("server.issue.move.moveTo", { status: t(`shared.status.${to}`) });
      const run = ["issue", "status", n, to];
      return statusMove(item, to)[0] === "round"
        ? { say: t("server.issue.move.roundWithText", { say, command: [...run, "--comment", "…"].join(" ") }) }
        : { say, run };
    });
  return [...acts, ...moves];
}
