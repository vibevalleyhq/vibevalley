import { createHash } from "node:crypto";

import { Clock, Effect, Formatter, Semaphore } from "effect";

import type * as T from "@vibevalley/protocol";

import { compareText, or } from "#/base/order.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { actionsJobOf } from "#/repo/pullSnapshot.ts";
import { Repo } from "#/repo/repo.ts";
import * as q from "#db/issue_github.sql.ts";

const failedChecks = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const finishedChecks = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR"]);

export const makeGitHubPoller = (onBoard: () => readonly T.Issue[]) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const mailbox = yield* Mailbox;
    const repos = yield* Repo;
    const polling = yield* Semaphore.make(1);

    /** Fetch logs via gh so helpers need no browser. */
    const jobLog = Effect.fnUntraced(function* (repo: string, url: string) {
      const job = actionsJobOf(url);
      if (!job) return "";
      const remote = yield* repos.githubRemote(repo).pipe(Effect.orElseSucceed(() => ""));
      if (!remote) return "";
      const log = yield* repos.githubRequest("run", "view", "--job", job, "--log-failed", "--repo", remote);
      if (!log.ok) return "";
      return log.out.trim().split("\n").slice(-40).join("\n").slice(-4000);
    });

    const poll = Effect.fn("Issue.pollPullRequest")(function* (issue: T.Issue) {
      const pr = issue.pullRequest;
      const repo = issue.repo;
      if (!repo || pr?.state !== "open") return;
      const current = yield* repos.githubSnapshot(repo, pr.number);
      yield* db.run(q.ensureGitHubCursor({ repo, pr_number: pr.number }));
      const cursor = yield* db.run(q.gitHubCursor({ repo, pr_number: pr.number }));
      const at = yield* Clock.currentTimeMillis;
      const scope = { repo, pr: pr.number };
      const base = { source: "github" as const, addressed: "thread_owner" as const, threads: [`issue:${issue.id}`, `github:${repo}#${pr.number}`], at };
      const checks = current.checks.toSorted((a, b) => or(compareText(a.name, b.name), compareText(a.url, b.url)));
      const fingerprint = createHash("sha256")
        .update(Formatter.formatJson({ head: current.head, checks }))
        .digest("hex");
      if (fingerprint !== cursor.check_fingerprint) {
        const revision = cursor.check_revision + 1;
        const failed = checks.filter((check) => failedChecks.has((check.conclusion || check.status).toUpperCase()));
        const failedText = yield* Effect.forEach(
          failed,
          (check) => Effect.map(jobLog(repo, check.url), (log) => `${check.name}: ${check.conclusion || check.status}${log ? "\n" + log : ""}`),
          { concurrency: 3 },
        );
        const finished = checks.length > 0 && checks.every((check) => check.conclusion !== "" || finishedChecks.has(check.status.toUpperCase()));
        if (failed.length > 0 || finished)
          yield* mailbox.accept({
            ...base,
            key: `${repo}#${pr.number}:ci:${revision}`,
            actor: { kind: "ci", id: `github:${repo}#${pr.number}` },
            text: (failed.length > 0 ? failedText : checks.map((check) => `${check.name}: ${check.conclusion || check.status}`)).join("\n"),
            data: { head: current.head, checks },
            meta: { ...scope, kind: "ci", head: current.head, fingerprint, failed: failed.length > 0 },
          });
        yield* db.run(q.observeGitHubChecks({ repo, pr_number: pr.number, check_fingerprint: fingerprint, check_revision: revision }));
      }
      const known = yield* mailbox.knownGitHubEvents(repo, pr.number);
      const keys = new Set(known.filter((event) => event.routed).map((event) => event.key));
      const rounds = new Map(
        known.flatMap((event) => (event.botRoundKey !== undefined && event.botRound !== undefined ? [[event.botRoundKey, event.botRound] as const] : [])),
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
      yield* Effect.forEach(
        events,
        (event) =>
          Effect.gen(function* () {
            if (keys.has(event.key) || event.author.toLowerCase() === current.viewer.toLowerCase()) return;
            const round = event.bot ? (rounds.get(event.round) ?? botRound + 1) : undefined;
            const accepted = yield* mailbox.accept({
              ...base,
              key: event.key,
              actor: { kind: event.bot ? "bot" : "collaborator", id: event.author || "deleted", name: event.author },
              text: event.text,
              data: event.data,
              meta: { ...scope, kind: event.kind, ...(round === undefined ? {} : { botRound: round, botRoundKey: event.round }) },
            });
            if (accepted) {
              keys.add(event.key);
              if (round !== undefined) {
                rounds.set(event.round, round);
                botRound = Math.max(botRound, round);
              }
            }
          }),
        { discard: true },
      );
    });

    return polling.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach(
          onBoard().filter((issue) => issue.pullRequest?.state === "open"),
          (issue) => poll(issue).pipe(bestEffort(`issue: GitHub issue #${issue.number}`)),
          { discard: true },
        ),
      ),
    );
  });
