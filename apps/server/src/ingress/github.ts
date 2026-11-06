import { createHash } from "node:crypto";

import { Clock, Effect, Schema, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import type { ApiError } from "#/base/errors.ts";
import { compareText, or } from "#/base/order.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Repo } from "#/repo/repo.ts";
import { RepoError } from "#/repo/workplace.ts";
import * as q from "#db/ingress_github.sql.ts";

import type { SourceEvent } from "./ingress.ts";

interface GitHubCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

interface GitHubReview {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly at: string;
  readonly bot: boolean;
}

interface GitHubComment {
  readonly id: string;
  readonly databaseId?: string;
  readonly author: string;
  readonly body: string;
  readonly url: string;
  readonly at: string;
  readonly bot: boolean;
  readonly reviewId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly diffHunk?: string;
  readonly threadId?: string;
  readonly resolved?: boolean;
}

export interface GitHubPullIngress {
  readonly viewer: string;
  readonly head: string;
  readonly checks: readonly GitHubCheck[];
  readonly reviews: readonly GitHubReview[];
  readonly comments: readonly GitHubComment[];
}

const Actor = Schema.NullOr(Schema.Struct({ login: Schema.String, __typename: Schema.String }));
const Review = Schema.Struct({ id: Schema.String, author: Actor, state: Schema.String, body: Schema.String, submittedAt: Schema.NullOr(Schema.String) });
const commentFields = { id: Schema.String, author: Actor, body: Schema.String, url: Schema.String, createdAt: Schema.String };
const Comment = Schema.Struct(commentFields);
const ReviewComment = Schema.Struct({
  ...commentFields,
  fullDatabaseId: Schema.NullOr(Schema.Union([Schema.String, Schema.Int])),
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  originalLine: Schema.NullOr(Schema.Int),
  diffHunk: Schema.String,
  pullRequestReview: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});
const Thread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({ totalCount: Schema.Int, edges: Schema.Array(Schema.Struct({ cursor: Schema.String, node: ReviewComment })) }),
});
const Check = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ __typename: Schema.Literal("StatusContext"), context: Schema.String, state: Schema.String, targetUrl: Schema.NullOr(Schema.String) }),
]);
const connection = <A, I>(node: Schema.Codec<A, I>) => Schema.Struct({ nodes: Schema.Array(node) });
const pullPages = <A, I>(pull: Schema.Codec<A, I>) =>
  Schema.Array(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({ pullRequest: pull }),
      }),
    }),
  );
const checkPages = Schema.Array(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        object: Schema.Struct({ statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: connection(Check) })) }),
      }),
    }),
  }),
);
const commentPages = Schema.Array(Schema.Struct({ data: Schema.Struct({ node: Schema.Struct({ comments: connection(ReviewComment) }) }) }));
const actorFields = "author{login __typename}";
const reviewCommentFields = `id fullDatabaseId ${actorFields} body url createdAt path line originalLine diffHunk pullRequestReview{id}`;
const pageInfo = "pageInfo{hasNextPage endCursor}";
const pullQuery = (operation: string, fields: string) =>
  `query ${operation}($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){${fields}}}}`;

const authorOf = (author: typeof Actor.Type) => ({
  author: author?.login ?? "",
  bot: author?.__typename === "Bot" || author?.login.endsWith("[bot]") === true,
});

export const githubSnapshot = (repos: Repo["Service"]) =>
  Effect.fn("Ingress.githubSnapshot")(function* (name: string, n: number): Effect.fn.Return<GitHubPullIngress, RepoError> {
    const repo = yield* repos.githubRemote(name);
    const unread = () => new RepoError({ message: t("server.repo.github.stateUnread", { n }) });
    const read = Effect.fn("Ingress.githubRead")(function* <A, I>(schema: Schema.Codec<A, I>, args: readonly string[]) {
      const response = yield* repos.githubRequest(...args);
      if (!response.ok) return yield* unread();
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(response.out).pipe(Effect.mapError(unread));
    });
    const head = (yield* read(Schema.Struct({ headRefOid: Schema.String }), ["pr", "view", String(n), "--repo", repo, "--json", "headRefOid"])).headRefOid;
    const [owner = "", repository = ""] = repo.split("/", 2);
    const variables = ["-f", `owner=${owner}`, "-f", `repo=${repository}`, "-F", `number=${n}`];
    const graphql = (query: string, fields: readonly string[] = variables) => ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, ...fields];
    const [viewer, checks, reviews, comments, threads] = yield* Effect.all(
      [
        read(Schema.Struct({ login: Schema.String }), ["api", "user"]),
        read(
          checkPages,
          graphql(
            `query IngressChecks($owner:String!,$repo:String!,$head:GitObjectID!,$endCursor:String){repository(owner:$owner,name:$repo){object(oid:$head){... on Commit{statusCheckRollup{contexts(first:100,after:$endCursor){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}} ${pageInfo}}}}}}}`,
            ["-f", `owner=${owner}`, "-f", `repo=${repository}`, "-f", `head=${head}`],
          ),
        ),
        read(
          pullPages(Schema.Struct({ reviews: connection(Review) })),
          graphql(pullQuery("IngressReviews", `reviews(first:100,after:$endCursor){nodes{id ${actorFields} state body submittedAt} ${pageInfo}}`)),
        ),
        read(
          pullPages(Schema.Struct({ comments: connection(Comment) })),
          graphql(pullQuery("IngressComments", `comments(first:100,after:$endCursor){nodes{id ${actorFields} body url createdAt} ${pageInfo}}`)),
        ),
        read(
          pullPages(Schema.Struct({ reviewThreads: connection(Thread) })),
          graphql(
            pullQuery(
              "IngressThreads",
              `reviewThreads(first:100,after:$endCursor){nodes{id isResolved comments(first:100){totalCount edges{cursor node{${reviewCommentFields}}}}} ${pageInfo}}`,
            ),
          ),
        ),
      ],
      { concurrency: 4 },
    );
    if (!viewer.login) return yield* unread();
    const inline = yield* Effect.forEach(
      threads.flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes),
      (thread) =>
        Effect.gen(function* () {
          const nodes = thread.comments.edges.map((edge) => edge.node);
          if (thread.comments.totalCount > nodes.length) {
            const cursor = thread.comments.edges.at(-1)?.cursor;
            if (!cursor) return yield* unread();
            const more = yield* read(
              commentPages,
              graphql(
                `query IngressThreadComments($id:ID!,$endCursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$endCursor){nodes{${reviewCommentFields}} ${pageInfo}}}}}`,
                ["-f", `id=${thread.id}`, "-f", `endCursor=${cursor}`],
              ),
            );
            for (const page of more) nodes.push(...page.data.node.comments.nodes);
          }
          return nodes.map((comment): GitHubComment => {
            const line = comment.line ?? comment.originalLine;
            const fullId = comment.fullDatabaseId;
            const databaseId = typeof fullId === "string" ? fullId : fullId !== null && Number.isSafeInteger(fullId) ? String(fullId) : undefined;
            return {
              id: comment.id,
              ...(databaseId === undefined ? {} : { databaseId }),
              ...authorOf(comment.author),
              body: comment.body,
              url: comment.url,
              at: comment.createdAt,
              ...(comment.pullRequestReview ? { reviewId: comment.pullRequestReview.id } : {}),
              path: comment.path,
              ...(line === null ? {} : { line }),
              diffHunk: comment.diffHunk,
              threadId: thread.id,
              resolved: thread.isResolved,
            };
          });
        }),
      { concurrency: 4 },
    );
    return {
      viewer: viewer.login,
      head,
      checks: checks
        .flatMap((page) => page.data.repository.object.statusCheckRollup?.contexts.nodes ?? [])
        .map((check) =>
          check.__typename === "CheckRun"
            ? { name: check.name, status: check.status, conclusion: check.conclusion ?? "", url: check.detailsUrl ?? "" }
            : { name: check.context, status: check.state, conclusion: "", url: check.targetUrl ?? "" },
        ),
      reviews: reviews
        .flatMap((page) => page.data.repository.pullRequest.reviews.nodes)
        .filter((review) => review.state !== "PENDING")
        .map((review) => ({
          id: review.id,
          ...authorOf(review.author),
          state: review.state,
          body: review.body,
          at: review.submittedAt ?? "",
        })),
      comments: [
        ...comments
          .flatMap((page) => page.data.repository.pullRequest.comments.nodes)
          .map((comment) => ({
            id: comment.id,
            ...authorOf(comment.author),
            body: comment.body,
            url: comment.url,
            at: comment.createdAt,
          })),
        ...inline.flat(),
      ],
    };
  });

const failedChecks = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const finishedChecks = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR"]);

/** The Actions job id in a check's details URL, or "" for a check that is not an Actions job. */
export const actionsJobOf = (url: string) => /\/job\/(\d+)/u.exec(url)?.[1] ?? "";

export const githubInputs = (accept: (event: SourceEvent) => Effect.Effect<T.Trigger | undefined, ApiError | Schema.SchemaError>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const mailbox = yield* Mailbox;
    const issues = yield* Issue;
    const repos = yield* Repo;
    const snapshot = githubSnapshot(repos);
    const polling = yield* Semaphore.make(1);

    /** A failed Actions job's last lines, fetched with gh so the helper need not open the browser. */
    const jobLog = Effect.fnUntraced(function* (repo: string, url: string) {
      const job = actionsJobOf(url);
      if (!job) return "";
      const remote = yield* repos.githubRemote(repo).pipe(Effect.orElseSucceed(() => ""));
      if (!remote) return "";
      const log = yield* repos.githubRequest("run", "view", "--job", job, "--log-failed", "--repo", remote);
      if (!log.ok) return "";
      return log.out.trim().split("\n").slice(-40).join("\n").slice(-4000);
    });

    const poll = Effect.fn("Ingress.pollPullRequest")(function* (issue: T.Issue) {
      const pr = issue.pullRequest;
      const repo = issue.repo;
      if (!repo || pr?.state !== "open") return;
      const current = yield* snapshot(repo, pr.number);
      yield* db.run(q.ensureGitHubCursor({ repo, pr_number: pr.number }));
      const cursor = yield* db.run(q.gitHubCursor({ repo, pr_number: pr.number }));
      const at = yield* Clock.currentTimeMillis;
      const scope = { repo, pr: pr.number };
      const base = { source: "github" as const, addressed: "thread_owner" as const, threads: [`issue:${issue.id}`, `github:${repo}#${pr.number}`], at };
      const checks = current.checks.toSorted((a, b) => or(compareText(a.name, b.name), compareText(a.url, b.url)));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ head: current.head, checks }))
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
          yield* accept({
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
