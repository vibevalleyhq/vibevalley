import { Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";

import type { Project } from "@/project/project.ts";
import { ProjectError } from "@/project/shapes.ts";

export interface GitHubCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

export interface GitHubReview {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly at: string;
  readonly bot: boolean;
}

export interface GitHubComment {
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

export const githubSnapshot = (projects: Project["Service"]) =>
  Effect.fn("Ingress.githubSnapshot")(function* (name: string, n: number): Effect.fn.Return<GitHubPullIngress, ProjectError> {
    const repo = yield* projects.githubRemote(name);
    const unread = () => new ProjectError({ message: t("server.project.github.stateUnread", { n }) });
    const read = Effect.fn("Ingress.githubRead")(function* <A, I>(schema: Schema.Codec<A, I>, args: readonly string[]) {
      const response = yield* projects.githubRequest(...args);
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
