import { z } from "zod";

import { mapConcurrent, Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import type { GitHubRun } from "./github.ts";
import { RepoError } from "./workplace.ts";

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

export interface GitHubPullSnapshot {
  readonly viewer: string;
  readonly head: string;
  readonly checks: readonly GitHubCheck[];
  readonly reviews: readonly GitHubReview[];
  readonly comments: readonly GitHubComment[];
}

const Actor = z.object({ login: z.string(), __typename: z.string() }).nullable();
const Review = z.object({ id: z.string(), author: Actor, state: z.string(), body: z.string(), submittedAt: z.string().nullable() });
const commentFields = { id: z.string(), author: Actor, body: z.string(), url: z.string(), createdAt: z.string() };
const Comment = z.object(commentFields);
const ReviewComment = z.object({
  ...commentFields,
  fullDatabaseId: z.union([z.string(), z.number().int()]).nullable(),
  path: z.string(),
  line: z.number().int().nullable(),
  originalLine: z.number().int().nullable(),
  diffHunk: z.string(),
  pullRequestReview: z.object({ id: z.string() }).nullable(),
});
const Thread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: z.object({ totalCount: z.number().int(), edges: z.array(z.object({ cursor: z.string(), node: ReviewComment })) }),
});
const Check = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
  }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string(), targetUrl: z.string().nullable() }),
]);
const connection = <A extends z.ZodType>(node: A) => z.object({ nodes: z.array(node) });
const pullPages = <A extends z.ZodType>(pull: A) =>
  z.array(
    z.object({
      data: z.object({
        repository: z.object({ pullRequest: pull }),
      }),
    }),
  );
const checkPages = z.array(
  z.object({
    data: z.object({
      repository: z.object({
        object: z.object({ statusCheckRollup: z.object({ contexts: connection(Check) }).nullable() }),
      }),
    }),
  }),
);
const commentPages = z.array(z.object({ data: z.object({ node: z.object({ comments: connection(ReviewComment) }) }) }));
const actorFields = "author{login __typename}";
const reviewCommentFields = `id fullDatabaseId ${actorFields} body url createdAt path line originalLine diffHunk pullRequestReview{id}`;
const pageInfo = "pageInfo{hasNextPage endCursor}";
const pullQuery = (operation: string, fields: string) =>
  `query ${operation}($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){${fields}}}}`;

const authorOf = (author: z.infer<typeof Actor>) => ({
  author: author?.login ?? "",
  bot: author?.__typename === "Bot" || author?.login.endsWith("[bot]") === true,
});

/** The Actions job id in a check's details URL, or "" for a check that is not an Actions job. */
export const actionsJobOf = (url: string) => /\/job\/(\d+)/u.exec(url)?.[1] ?? "";

export const makeGithubSnapshot =
  (gh: GitHubRun, githubRemote: (name: string) => Promise<string>) =>
  async (name: string, n: number): Promise<GitHubPullSnapshot> => {
    const repo = await githubRemote(name);
    const unread = () => new RepoError(t("server.repo.github.stateUnread", { n }));
    const read = async <S extends z.ZodType>(schema: S, args: readonly string[]): Promise<z.output<S>> => {
      const response = await gh(...args);
      if (!response.ok) throw unread();
      let raw: unknown;
      try {
        raw = JSON.parse(response.out);
      } catch {
        // gh said something that is not JSON: not its answer.
        throw unread();
      }
      const got = schema.safeParse(raw);
      if (!got.success) throw unread();
      return got.data;
    };
    const head = (await read(z.object({ headRefOid: z.string() }), ["pr", "view", String(n), "--repo", repo, "--json", "headRefOid"])).headRefOid;
    const [owner = "", repository = ""] = repo.split("/", 2);
    const variables = ["-f", `owner=${owner}`, "-f", `repo=${repository}`, "-F", `number=${n}`];
    const graphql = (query: string, fields: readonly string[] = variables) => ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, ...fields];
    // Four of the five reads at a time, as gh is asked elsewhere too.
    const four = new Semaphore(4);
    const [viewer, checks, reviews, comments, threads] = await Promise.all([
      four.with(() => read(z.object({ login: z.string() }), ["api", "user"])),
      four.with(() =>
        read(
          checkPages,
          graphql(
            `query PullChecks($owner:String!,$repo:String!,$head:GitObjectID!,$endCursor:String){repository(owner:$owner,name:$repo){object(oid:$head){... on Commit{statusCheckRollup{contexts(first:100,after:$endCursor){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}} ${pageInfo}}}}}}}`,
            ["-f", `owner=${owner}`, "-f", `repo=${repository}`, "-f", `head=${head}`],
          ),
        ),
      ),
      four.with(() =>
        read(
          pullPages(z.object({ reviews: connection(Review) })),
          graphql(pullQuery("PullReviews", `reviews(first:100,after:$endCursor){nodes{id ${actorFields} state body submittedAt} ${pageInfo}}`)),
        ),
      ),
      four.with(() =>
        read(
          pullPages(z.object({ comments: connection(Comment) })),
          graphql(pullQuery("PullComments", `comments(first:100,after:$endCursor){nodes{id ${actorFields} body url createdAt} ${pageInfo}}`)),
        ),
      ),
      four.with(() =>
        read(
          pullPages(z.object({ reviewThreads: connection(Thread) })),
          graphql(
            pullQuery(
              "PullThreads",
              `reviewThreads(first:100,after:$endCursor){nodes{id isResolved comments(first:100){totalCount edges{cursor node{${reviewCommentFields}}}}} ${pageInfo}}`,
            ),
          ),
        ),
      ),
    ]);
    if (!viewer.login) throw unread();
    const inline = await mapConcurrent(
      threads.flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes),
      4,
      async (thread) => {
        const nodes = thread.comments.edges.map((edge) => edge.node);
        if (thread.comments.totalCount > nodes.length) {
          const cursor = thread.comments.edges.at(-1)?.cursor;
          if (!cursor) throw unread();
          const more = await read(
            commentPages,
            graphql(
              `query PullThreadComments($id:ID!,$endCursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$endCursor){nodes{${reviewCommentFields}} ${pageInfo}}}}}`,
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
      },
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
  };
