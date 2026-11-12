import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const issueDeleteInput = input({ id: z.string() });
const issueStatusUpdateInput = input({ id: z.string() }, S.IssueStatusRequest);

export interface IssueHandlers {
  readonly "issue.conversation.get": (a: { readonly id: string }) => Promise<string | null>;
  /** To the issue's newest session, as the user: a comment is on the issue, not on one step. A closed issue is refused: reopen it. */
  readonly "issue.comment.create": (a: { readonly id: string } & T.CommentRequest) => Promise<T.Applied>;
  readonly "issue.diff.get": (a: { readonly id: string }) => Promise<T.Changes>;
  /** One joined read of issues and their real sessions, including explicit missing records. */
  readonly "issue.history.list": () => Promise<T.IssueHistory[]>;
  /** The open issues by default, the newest first; the filter narrows them. */
  readonly "issue.list": (a: T.IssueFilter) => Promise<T.Issue[]>;
  /** A verdict on what was handed back; a pass only makes it ready, completing it is issue.status.update to done. */
  readonly "issue.review": (a: { readonly id: string } & T.IssueReviewRequest) => Promise<T.Issue>;
  /** The issue becomes a parent issue and the split's issues its children, started at once. */
  readonly "issue.split": (a: { readonly id: string } & T.IssueSplitRequest) => Promise<string>;
  readonly "issue.get": (a: { readonly id: string }) => Promise<T.Issue>;
  readonly "issue.run.list": (a: { readonly id: string }) => Promise<T.Run[]>;
  /** The issue's milestones, newest first, and what all its runs cost. */
  readonly "issue.timeline.get": (a: { readonly id: string }) => Promise<T.IssueTimeline>;
  readonly "issue.create": (a: T.IssueRequest) => Promise<T.AppliedIssue>;
  readonly "issue.update": (a: { readonly id: string } & T.IssueUpdate) => Promise<T.AppliedIssue>;
  readonly "issue.delete": (a: { readonly id: string }) => Promise<void>;
  /** What issue.delete would do, refused as it would be; nothing changes. */
  readonly "issue.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
  /** Moving an issue is what it does, by where it stands: todo sends it out (or waits for room), or back from review is another round (the words are the findings. */
  readonly "issue.status.update": (a: { readonly id: string } & T.IssueStatusRequest) => Promise<T.AppliedIssue>;
  /** What issue.status.update would do with the same body, refused as it would be; nothing changes. */
  readonly "issue.status.previewUpdate": (a: { readonly id: string } & T.IssueStatusRequest) => Promise<T.Preview>;
  /** A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then leaves. */
  readonly "issue.refine": (a: { readonly id: string } & T.IssueRefineRequest) => Promise<T.Issue>;
}

export const issueEndpoints: readonly Endpoint[] = [
  { op: "issue.conversation.get", about: ["id"], input: input({ id: z.string() }), result: z.string().nullable(), can: ["user", "remote"] },
  {
    op: "issue.comment.create",
    about: ["id"],
    input: input({ id: z.string() }, S.CommentRequest),
    result: S.Applied,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.diff.get",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.Changes,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.history.list",
    about: [],
    input: undefined,
    result: z.array(S.IssueHistory),
    can: ["user", "remote"],
  },
  {
    op: "issue.list",
    about: [],
    input: S.IssueFilter,
    result: z.array(S.Issue),
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.review",
    about: ["id"],
    input: input({ id: z.string() }, S.IssueReviewRequest),
    result: S.Issue,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.split",
    about: ["id"],
    input: input({ id: z.string() }, S.IssueSplitRequest),
    result: z.string(),
    can: ["user", "remote", "session"],
  },
  {
    op: "issue.get",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.Issue,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.run.list",
    about: ["id"],
    input: input({ id: z.string() }),
    result: z.array(S.Run),
    can: ["user", "remote"],
  },
  {
    op: "issue.timeline.get",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.IssueTimeline,
    can: ["user", "remote"],
  },
  {
    op: "issue.create",
    about: [],
    input: S.IssueRequest,
    result: S.AppliedIssue,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.update",
    about: ["id"],
    input: input({ id: z.string() }, S.IssueUpdate),
    result: S.AppliedIssue,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.delete",
    about: ["id"],
    input: issueDeleteInput,
    result: undefined,
    can: ["user", "remote"],
    dryRun: "issue.previewDelete",
  },
  {
    op: "issue.previewDelete",
    about: ["id"],
    input: issueDeleteInput,
    result: S.Preview,
    can: ["user", "remote"],
  },
  {
    op: "issue.status.update",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.AppliedIssue,
    can: ["user", "remote", "orchestrator"],
    dryRun: "issue.status.previewUpdate",
  },
  {
    op: "issue.status.previewUpdate",
    about: ["id"],
    input: issueStatusUpdateInput,
    result: S.Preview,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "issue.refine",
    about: ["id"],
    input: input({ id: z.string() }, S.IssueRefineRequest),
    result: S.Issue,
    can: ["user", "remote"],
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
