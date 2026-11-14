import { createHash } from "node:crypto";

import { mapConcurrent, Semaphore } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { compareText, or } from "#/base/order.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { Accepted } from "#/modules/session/envelope.ts";
import type { SourceEvent } from "#/modules/session/payload.ts";
import * as q from "#db/issue_github_cursor.sql.ts";
import * as qe from "#db/issue_github_event.sql.ts";

const failedChecks = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const finishedChecks = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR"]);

/** A pull request's checks as its helper is told of them: the failed ones, and whether every one has finished. */
export function checksVerdict<C extends { readonly status: string; readonly conclusion: string }>(
  checks: readonly C[],
): { readonly failed: C[]; readonly finished: boolean } {
  return {
    failed: checks.filter((check) => failedChecks.has((check.conclusion || check.status).toUpperCase())),
    finished: checks.length > 0 && checks.every((check) => check.conclusion !== "" || finishedChecks.has(check.status.toUpperCase())),
  };
}

export interface GitHubPollDeps {
  readonly db: Db;
  readonly repo: Repo;
  readonly clock: Time;
  readonly log: Logger;
  /** A source's event recorded as a trigger and routed. */
  readonly receive: (event: SourceEvent) => Promise<Accepted>;
}

/** The open pull requests on the board followed on GitHub: a CI run that failed or finished, and each review and
 * comment not seen before, taken in as triggers for the issue's thread. */
export function makeGitHubPoller(deps: GitHubPollDeps) {
  const { db, repo: repos, clock, log, receive } = deps;
  const polling = new Semaphore(1);

  const poll = async (issue: T.Issue) => {
    const pr = issue.pullRequest;
    const repo = issue.repo;
    if (!repo || pr?.state !== "open") return;
    const current = await repos.githubSnapshot(repo, pr.number);
    await q.ensureGitHubCursor(db.sql, { repo, pr_number: pr.number });
    const cursor = await q.gitHubCursor(db.sql, { repo, pr_number: pr.number });
    if (cursor === undefined) throw new Inconsistent(`${repo}#${pr.number}: the GitHub cursor just ensured is not there`);
    const at = clock.now();
    const scope = { repo, pr: pr.number };
    const base = { source: "github" as const, addressed: "thread_owner" as const, threads: [`issue:${issue.id}`, `github:${repo}#${pr.number}`], at };
    const checks = current.checks.toSorted((a, b) => or(compareText(a.name, b.name), compareText(a.url, b.url)));
    const fingerprint = createHash("sha256")
      .update(jsonText({ head: current.head, checks }))
      .digest("hex");
    if (fingerprint !== cursor.check_fingerprint) {
      const revision = cursor.check_revision + 1;
      const { failed, finished } = checksVerdict(checks);
      const failedText = await mapConcurrent(failed, 3, async (check) => {
        const job = await repos.failedJobLog(repo, check.url);
        return `${check.name}: ${check.conclusion || check.status}${job ? "\n" + job : ""}`;
      });
      if (failed.length > 0 || finished)
        await receive({
          ...base,
          key: `${repo}#${pr.number}:ci:${revision}`,
          actor: { kind: "system", id: `github:${repo}#${pr.number}` },
          text: (failed.length > 0 ? failedText : checks.map((check) => `${check.name}: ${check.conclusion || check.status}`)).join("\n"),
          data: { head: current.head, checks },
          meta: { ...scope, kind: "ci", head: current.head, fingerprint, failed: failed.length > 0 },
        });
      await q.observeGitHubChecks(db.sql, { repo, pr_number: pr.number, check_fingerprint: fingerprint, check_revision: revision });
    }
    const known = await qe.knownGitHubEvents(db.sql, { repo, pr_number: pr.number });
    const keys = new Set(known.map((event) => event.key));
    const rounds = new Map(
      known.flatMap((event) => (event.bot_round_key !== null && event.bot_round !== null ? [[event.bot_round_key, event.bot_round] as const] : [])),
    );
    let botRound = 0;
    for (const round of rounds.values()) botRound = Math.max(botRound, round);
    const events = [
      ...current.reviews.map((review) => ({
        key: `${repo}#${pr.number}:review:${review.id}`,
        author: review.author,
        bot: review.bot,
        round: `${review.author}:review:${review.id}`,
        occurred: review.at,
        text: `${review.author} ${review.state}\n${review.body}`.trim(),
        data: review,
        kind: "review" as const,
      })),
      ...current.comments.map((comment) => ({
        key: `${repo}#${pr.number}:comment:${comment.id}`,
        author: comment.author,
        bot: comment.bot,
        round: comment.reviewId ? `${comment.author}:review:${comment.reviewId}` : `${comment.author}:comment:${comment.id}`,
        occurred: comment.at,
        text: [
          comment.author,
          comment.path ? `${comment.path}${comment.line === undefined ? "" : `:${comment.line}`}` : "",
          comment.diffHunk?.split("\n").slice(-3).join("\n"),
          comment.body,
        ]
          .filter(Boolean)
          .join("\n"),
        data: comment,
        kind: "comment" as const,
      })),
    ].toSorted((a, b) => or(compareText(a.occurred, b.occurred), compareText(a.key, b.key)));
    for (const event of events) {
      if (keys.has(event.key) || event.author.toLowerCase() === current.viewer.toLowerCase()) continue;
      const round = event.bot ? (rounds.get(event.round) ?? botRound + 1) : undefined;
      const accepted = await receive({
        ...base,
        key: event.key,
        actor: { kind: "system", id: event.author || "deleted", name: event.author },
        text: event.text,
        data: event.data,
        meta: { ...scope, kind: event.kind, ...(round === undefined ? {} : { botRound: round, botRoundKey: event.round }) },
      });
      if (accepted.trigger) {
        await qe.keepGitHubEvent(db.sql, {
          repo,
          pr_number: pr.number,
          key: event.key,
          bot_round_key: round === undefined ? null : event.round,
          bot_round: round ?? null,
        });
        keys.add(event.key);
        if (round !== undefined) {
          rounds.set(event.round, round);
          botRound = Math.max(botRound, round);
        }
      }
    }
  };

  const pollOpen = (onBoard: readonly T.Issue[]): Promise<void> =>
    polling.with(async () => {
      for (const issue of onBoard.filter((issue) => issue.pullRequest?.state === "open"))
        await bestEffort(log, `issue: GitHub issue #${issue.number}`, () => poll(issue));
    });
  return { pollOpen };
}
