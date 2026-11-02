import { createHash } from "node:crypto";

import { Clock, Effect, type Schema, Semaphore } from "effect";

import type * as T from "@vibevalley/protocol";

import { compareText, or } from "@/base/order.ts";
import type { ApiError } from "@/errors.ts";
import { Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Issue } from "@/issue/issue.ts";
import { Project } from "@/project/project.ts";

import * as q from "../../db/generated/ingress_github.sql.ts";
import * as qt from "../../db/generated/ingress_trigger.sql.ts";
import { githubSnapshot } from "./github-source.ts";
import type { SourceEvent } from "./ingress.ts";

const failedChecks = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const finishedChecks = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR"]);

export const githubInputs = (accept: (event: SourceEvent) => Effect.Effect<T.Trigger | undefined, ApiError | Schema.SchemaError>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const issues = yield* Issue;
    const snapshot = githubSnapshot(yield* Project);
    const polling = yield* Semaphore.make(1);

    const poll = Effect.fn("Ingress.pollPullRequest")(function* (issue: T.Issue) {
      const pr = issue.pullRequest;
      const project = issue.project;
      if (!project || pr?.state !== "open") return;
      const current = yield* snapshot(project, pr.number);
      yield* db.run(q.ensureGitHubCursor({ project, pr_number: pr.number }));
      const cursor = yield* db.run(q.gitHubCursor({ project, pr_number: pr.number }));
      const at = yield* Clock.currentTimeMillis;
      const scope = { project, pr: pr.number };
      const base = { source: "github" as const, addressed: "thread_owner" as const, threads: [`issue:${issue.id}`, `github:${project}#${pr.number}`], at };
      const checks = current.checks.toSorted((a, b) => or(compareText(a.name, b.name), compareText(a.url, b.url)));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ head: current.head, checks }))
        .digest("hex");
      if (fingerprint !== cursor.check_fingerprint) {
        const revision = cursor.check_revision + 1;
        const failed = checks.filter((check) => failedChecks.has((check.conclusion || check.status).toUpperCase()));
        const finished = checks.length > 0 && checks.every((check) => check.conclusion !== "" || finishedChecks.has(check.status.toUpperCase()));
        if (failed.length > 0 || finished)
          yield* accept({
            ...base,
            key: `${project}#${pr.number}:ci:${revision}`,
            actor: { kind: "ci", id: `github:${project}#${pr.number}` },
            text: (failed.length > 0 ? failed : checks).map((check) => `${check.name}: ${check.conclusion || check.status}`).join("\n"),
            data: { head: current.head, checks },
            meta: { ...scope, kind: "ci", head: current.head, fingerprint, failed: failed.length > 0 },
          });
        yield* db.run(q.observeGitHubChecks({ project, pr_number: pr.number, check_fingerprint: fingerprint, check_revision: revision }));
      }
      const known = yield* db.run(qt.knownGitHubEvents({ project, pr_number: pr.number }));
      const keys = new Set(known.filter((event) => event.routed).map((event) => event.source_key));
      const rounds = new Map(
        known.flatMap((event) => (event.bot_round_key !== null && event.bot_round !== null ? [[event.bot_round_key, event.bot_round] as const] : [])),
      );
      let botRound = 0;
      for (const round of rounds.values()) botRound = Math.max(botRound, round);
      const events = [
        ...current.reviews.map((review) => ({
          key: `${project}#${pr.number}:review:${review.id}`,
          author: review.author,
          bot: review.bot,
          round: `${review.author}:review:${review.id}`,
          occurred: review.at,
          text: `${review.author} ${review.state}\n${review.body}`.trim(),
          data: review,
          kind: "review",
        })),
        ...current.comments.map((comment) => ({
          key: `${project}#${pr.number}:comment:${comment.id}`,
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
          kind: "comment",
        })),
      ].toSorted((a, b) => or(compareText(a.occurred, b.occurred), compareText(a.key, b.key)));
      yield* Effect.forEach(
        events,
        (event) =>
          Effect.gen(function* () {
            if (keys.has(event.key) || event.author.toLowerCase() === current.viewer.toLowerCase()) return;
            const round = event.bot ? (rounds.get(event.round) ?? botRound + 1) : undefined;
            const accepted = yield* accept({
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

    const refresh = polling.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach(
          issues.onBoard().filter((issue) => issue.pullRequest?.state === "open"),
          (issue) => poll(issue).pipe(bestEffort(`ingress: GitHub issue #${issue.number}`)),
          { discard: true },
        ),
      ),
    );
    return { snapshot, refresh };
  });
