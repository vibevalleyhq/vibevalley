import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import type { ApiError, IssueHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import { BizCode, bizError } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { requestKeys } from "#/gateway/http/api.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { Session } from "#/modules/session/session.ts";

export const issueHandlers = Effect.gen(function* () {
  const core = yield* Core;
  const sessions = yield* Session;
  const channels = yield* Channel;
  const issues = yield* Issue;
  /** An issue's id, with the fields the user changed beside an act saved first. */
  const edited = (ref: string, edit: T.IssueUpdate | undefined) => Effect.tap(issues.idOf(ref), (id) => (edit ? issues.edit(id, edit, user) : Effect.void));
  /** The issue with the seq read once its service has applied its facts: the first frame at that seq shows the change. */
  const applied = (issue: Effect.Effect<T.Issue, ApiError>) => Effect.map(issue, (i): T.AppliedIssue => ({ ...i, seq: core.seq() }));
  const createOnce = yield* requestKeys<T.AppliedIssue>();
  const statusOnce = yield* requestKeys<T.AppliedIssue>();
  const done: IssueHandlers = {
    "issue.conversation.get": ({ id }) => Effect.flatMap(issues.get(id), (issue) => channels.issueThreadId(issue.id)),
    "issue.list": (filter) => issues.query(filter),
    "issue.review": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.review(id, body)),
    "issue.split": ({ id: ref, ...body }) => Effect.flatMap(issues.idOf(ref), (id) => issues.split(id, body.title ?? "", body.tasks, user)),
    "issue.history.list": () => issues.history(),
    "issue.get": ({ id }) => issues.get(id),
    "issue.run.list": ({ id }) => Effect.flatMap(issues.get(id), (issue) => sessions.issueRuns(issue.id)),
    "issue.timeline.get": ({ id }) => issues.timeline(id),
    "issue.create": ({ requestKey, autoSubmitPr, ...body }) =>
      createOnce(
        requestKey,
        applied(
          issues.create({ ...body, by: user, ...(autoSubmitPr !== undefined ? { autoSubmitPr } : {}) }).pipe(
            Effect.map((created) => created.issue),
            Effect.catchTag("IssueCreateRefused", (e) => Effect.fail(e.error ?? bizError(BizCode.IssueRefused, e.reason))),
          ),
        ),
      ),
    "issue.update": ({ id: ref, ...body }) => applied(Effect.flatMap(issues.idOf(ref), (id) => issues.edit(id, body, user))),
    "issue.delete": ({ id: ref }) => Effect.flatMap(issues.idOf(ref), (id) => issues.remove(id)),
    "issue.previewDelete": ({ id }) => issues.previewRemove(id),
    "issue.status.previewUpdate": ({ id, ...body }) =>
      issues.previewStatus(id, body.status, body.text ?? "", body.agent ? { agent: body.agent } : {}, body.edit),
    "issue.refine": ({ id: ref, ...body }) => Effect.flatMap(edited(ref, body.edit), (id) => issues.refine(id, body.text ?? "", channels.defaultChannel())),
    "issue.status.update": ({ id: ref, ...body }) =>
      statusOnce(
        body.requestKey,
        applied(
          Effect.flatMap(edited(ref, body.edit), (id) =>
            issues.setStatus(id, body.status, body.text ?? "", channels.defaultChannel(), user, body.agent ? { agent: body.agent } : {}),
          ),
        ),
      ),
    "issue.comment.create": ({ id: ref, ...body }) =>
      Effect.flatMap(issues.idOf(ref), (id) => Effect.map(issues.comment(id, body.text, body.sendKey ?? "", user), (): T.Applied => ({ seq: core.seq() }))),
    "issue.diff.get": ({ id }) => issues.changes(id, user),
  };
  return done;
});
