import type * as T from "@vibevalley/protocol";

import type { WaitingInput } from "#/modules/session/envelope.ts";
import type { Trigger } from "#/modules/session/shapes.ts";

/** The issue holds its inputs until the user answers: it asks, is stuck, or waits for the user's verdict. */
const waitsForHuman = (issue: Pick<T.Issue, "stage">) => issue.stage.state === "asking" || issue.stage.state === "stuck" || issue.stage.state === "reviewing";

/** Why an input for an issue stays held in its pool: past the issue's bot review rounds, no one to take it, or the
 * issue waits on the user; the user's own words (human) pass the first and the last. Undefined: it goes on now. */
export const holdReasonOf = (
  trigger: Pick<Trigger, "meta" | "actor">,
  issue: Pick<T.Issue, "stage" | "mandate">,
  recipient: string | undefined,
  human: boolean,
): "budget" | "session" | "human" | undefined =>
  trigger.meta.botRound !== undefined && trigger.meta.botRound > issue.mandate.maxBotReviewRounds && !human
    ? "budget"
    : !recipient
      ? "session"
      : waitsForHuman(issue) && trigger.actor.kind !== "user" && !human
        ? "human"
        : undefined;

const isOpen = (issue: Pick<T.Issue, "status">) => issue.status !== "done" && issue.status !== "canceled";

/** Which of a session's waiting inputs may be handed to it now (Session.useReadiness): none of a closed issue's, and
 * while an issue waits on the user only the user's words, or everything once the user's words wait there too. An input
 * for no issue on the board goes. */
export function readyInputs(inputs: readonly WaitingInput[], issueOf: (id: string) => Pick<T.Issue, "id" | "status" | "stage"> | undefined): boolean[] {
  const issues = inputs.map((input) => (input.issue === undefined ? undefined : issueOf(input.issue)));
  const answered = new Set(inputs.flatMap((input, i) => (input.fromUser && input.pending && issues[i] && isOpen(issues[i]) ? [issues[i].id] : [])));
  return inputs.map((input, i) => {
    const issue = issues[i];
    return !issue || (isOpen(issue) && (!waitsForHuman(issue) || input.fromUser || answered.has(issue.id)));
  });
}

/** How far an input's delivery to its last session got (InputReceipt). */
export interface Receipt {
  readonly state: "pending" | "handed" | "consumed" | "dropped";
  readonly dropped_why: string | null;
}

/** An input forwarded to an earlier session goes on to the next unless that one took it in, or it was deleted: none
 * delivered, still waiting, or dropped because that session left or it went elsewhere. */
export const goesOnFrom = (receipt: Receipt | undefined): boolean =>
  receipt === undefined ||
  receipt.state === "pending" ||
  receipt.state === "handed" ||
  (receipt.state === "dropped" && (receipt.dropped_why === "left" || receipt.dropped_why === "reassigned"));
