import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { type CheckoutChecks, MergeFailure } from "#/modules/repo/workplace.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";

import { acceptanceAncestors } from "./dependencies.ts";
import type { IssueLanding } from "./landing.ts";
import { statusMove } from "./moves.ts";

const refused = refuseIn(BizCode.IssueRefused);

interface MergeDeps {
  readonly core: Core;
  readonly sessions: Session;
  readonly chat: Channel;
  readonly landing: IssueLanding;
  readonly get: (ref: string) => Promise<T.Issue>;
  readonly list: () => Promise<T.Issue[]>;
  readonly setConflict: (id: string, conflict: T.Conflict | undefined) => Promise<void>;
}

export function merging(d: MergeDeps) {
  const { core, sessions, chat, landing, get, list, setConflict } = d;
  /** Merges by pull request and the poll of their states, one at a time. */
  const prLock = new Semaphore(1);

  const notTaken = async (id: string, n: NotTakenIn) => {
    const issue = sessions.live(id).session?.issue;
    if (issue && n.failure.kind === "conflict") await setConflict(issue, { base: n.failure.base, files: [...n.failure.files] });
    let [user, line] = [n.user, n.notice];
    if (n.fix) {
      let untold = "";
      try {
        await chat.post({ _tag: "Tell", from: userId, session: id, text: n.fix, sendKey: "" });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        untold = t("server.issue.merge.tellFailed", { why: e.message });
      }
      [user, line] = [user + untold, line + untold];
    }
    core.notice("warn", line);
    return refused(user);
  };

  const merge = (id: string, accepted: boolean = false): Promise<string> =>
    prLock.with(async () => {
      const issue = await get(id);
      // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table.
      if (!accepted) {
        const [m, why] = statusMove(issue, "done");
        if (m === "none") throw refused(why);
      }
      // A parent's children merged into its branch: it goes from its own checkout once its helper is gone.
      const fromCheckout = (await list()).some((child) => child.parent === issue.id);
      try {
        return await landing.merge(issue, fromCheckout);
      } catch (e) {
        const last = latestSessionIdOf(issue);
        if (e instanceof NotTakenIn && last !== undefined) throw await notTaken(last, e);
        throw e;
      }
    });

  const refreshPullRequests = (): Promise<void> =>
    prLock.with(async () => {
      const followed = (await list()).map((issue) => ({ issue, finishes: finishesWithPullRequest(issue) }));
      await landing.refreshPullRequests(followed);
    });

  const submit = (id: string, session: string, summary?: string): Promise<string> =>
    prLock.with(async () => {
      try {
        return await landing.submitPullRequest(
          session,
          async () => {
            const issue = await get(id);
            if (issue.status === "done" || issue.status === "canceled") throw refused(t("server.issue.closedReopen"));
            return issue;
          },
          summary,
        );
      } catch (error) {
        if (error instanceof MergeFailure) throw refused(error.message);
        throw error;
      }
    });

  return { merge, refreshPullRequests, submit };
}

/** A followed pull request's end finishes its issue: one still open that delivers by merging (one that delivers the
 * pull request itself is done already, and a closed one only keeps the state). */
export const finishesWithPullRequest = (issue: Pick<T.Issue, "deliver" | "closedAt">) => issue.deliver !== "pull_request" && issue.closedAt === undefined;

/** What a child's work must pass before it merges into its parent: its own check, the acceptance ancestors' frozen
 * files, and (the last of its siblings) their checks. */
export function childChecks(child: T.Issue, all: readonly T.Issue[]): CheckoutChecks {
  const constraints = child.constraints;
  const inherited = acceptanceAncestors(child, all);
  if (constraints?.acceptance === true) return { acceptance: true, check: constraints.check ?? "" };
  const frozen = [...new Set(inherited.flatMap((item) => item.constraints?.frozen ?? []))];
  const leaf = !all.some((item) => item.parent === child.parent && item.status !== "canceled" && item.blockedBy.includes(child.id));
  const checks = [
    ...new Set([constraints?.check, ...(leaf ? inherited.map((item) => item.constraints?.check) : [])].flatMap((check) => (check ? [check] : []))),
  ];
  return { acceptance: false, frozen, checks };
}
