import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const issueDeleteInput = input({ id: Schema.String });
const issueStatusUpdateInput = input({ id: Schema.String }, S.IssueStatusRequest);

export interface IssueHandlers<R = never> {
  readonly "issue.conversation.get": (a: { readonly id: string }) => Effect.Effect<string | null, ApiError, R>;
  /** To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
  readonly "issue.comment.create": (a: { readonly id: string } & T.CommentRequest) => Effect.Effect<T.Applied, ApiError, R>;
  readonly "issue.diff.get": (a: { readonly id: string }) => Effect.Effect<T.Changes, ApiError, R>;
  /** One joined read of issues and their real sessions, including explicit missing records. */
  readonly "issue.history.list": () => Effect.Effect<T.IssueHistory[], ApiError, R>;
  /** The open issues by default, the newest first; the filter narrows them. */
  readonly "issue.list": (a: T.IssueFilter) => Effect.Effect<T.Issue[], ApiError, R>;
  /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
  readonly "issue.review": (a: { readonly id: string } & T.IssueReviewRequest) => Effect.Effect<T.Issue, ApiError, R>;
  /** The issue becomes a parent issue and the split's issues its children, started at once. */
  readonly "issue.split": (a: { readonly id: string } & T.IssueSplitRequest) => Effect.Effect<string, ApiError, R>;
  readonly "issue.get": (a: { readonly id: string }) => Effect.Effect<T.Issue, ApiError, R>;
  readonly "issue.run.list": (a: { readonly id: string }) => Effect.Effect<T.Run[], ApiError, R>;
  /** The issue's milestones, newest first, and what all its runs cost. */
  readonly "issue.timeline.get": (a: { readonly id: string }) => Effect.Effect<T.IssueTimeline, ApiError, R>;
  readonly "issue.create": (a: T.IssueRequest) => Effect.Effect<T.AppliedIssue, ApiError, R>;
  readonly "issue.update": (a: { readonly id: string } & T.IssueUpdate) => Effect.Effect<T.AppliedIssue, ApiError, R>;
  readonly "issue.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What issue.delete would do, refused as it would be; nothing changes. */
  readonly "issue.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is another round (the words are the findings. */
  readonly "issue.status.update": (a: { readonly id: string } & T.IssueStatusRequest) => Effect.Effect<T.AppliedIssue, ApiError, R>;
  /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
  readonly "issue.status.previewUpdate": (a: { readonly id: string } & T.IssueStatusRequest) => Effect.Effect<T.Preview, ApiError, R>;
  /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then leaves. */
  readonly "issue.refine": (a: { readonly id: string } & T.IssueRefineRequest) => Effect.Effect<T.Issue, ApiError, R>;
}

export const issueEndpoints: readonly Endpoint[] = [
  { op: "issue.conversation.get", about: ["id"], input: input({ id: Schema.String }), result: Schema.NullOr(Schema.String), can: ["owner", "remote"] },
  {
    op: "issue.comment.create",
    about: ["id"],
    input: input({ id: Schema.String }, S.CommentRequest),
    result: S.Applied,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.diff.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Changes,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.history.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.IssueHistory)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.list",
    about: [],
    input: S.IssueFilter,
    result: Schema.mutable(Schema.Array(S.Issue)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.review",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueReviewRequest),
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.split",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueSplitRequest),
    result: Schema.String,
    can: ["owner", "remote", "session"],
  },
  {
    op: "issue.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Issue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.run.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: Schema.mutable(Schema.Array(S.Run)),
    can: ["owner", "remote"],
  },
  {
    op: "issue.timeline.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.IssueTimeline,
    can: ["owner", "remote"],
  },
  {
    op: "issue.create",
    about: [],
    input: S.IssueRequest,
    result: S.AppliedIssue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueUpdate),
    result: S.AppliedIssue,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.delete",
    about: ["id"],
    input: issueDeleteInput,
    result: undefined,
    can: ["owner", "remote"],
    dryRun: "issue.previewDelete",
  },
  {
    op: "issue.previewDelete",
    about: ["id"],
    input: issueDeleteInput,
    result: S.Preview,
    can: ["owner", "remote"],
  },
  {
    op: "issue.status.update",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.AppliedIssue,
    can: ["owner", "remote", "orchestrator"],
    dryRun: "issue.status.previewUpdate",
  },
  {
    op: "issue.status.previewUpdate",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.Preview,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "issue.refine",
    about: ["id"],
    input: input({ id: Schema.String }, S.IssueRefineRequest),
    result: S.Issue,
    can: ["owner", "remote"],
  },
];

/** The command that does one of an issue's acts (without `vibevalley`). */
export function actCommand(
  issue: { readonly number: number },
  a: T.IssueAction,
  session: string | undefined,
): { readonly run: readonly string[]; readonly words: T.ActWords } | undefined {
  const n = String(issue.number);
  switch (a.does) {
    case "move":
      return { run: ["issue", "status", n, a.status], words: a.words };
    case "say":
      return { run: ["issue", "comment", n], words: "required" };
    case "stop":
      return session === undefined ? undefined : { run: ["session", "stop", session], words: "none" };
  }
}
