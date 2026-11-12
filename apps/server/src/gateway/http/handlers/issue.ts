import type * as T from "@vibevalley/protocol";
import type { IssueHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import { BizCode, bizError } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { requestKeys } from "#/gateway/http/api.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { type Issue, IssueCreateRefused } from "#/modules/issue/issue.ts";

export interface IssueHandlersDeps {
  readonly core: Core;
  readonly channel: Channel;
  readonly issue: Issue;
  readonly clock: Time;
}

export function issueHandlers(deps: IssueHandlersDeps): IssueHandlers {
  const { core, channel: channels, issue: issues } = deps;
  /** An issue's id, with the fields the user changed beside an act saved first. */
  const edited = async (ref: string, edit: T.IssueUpdate | undefined) => {
    const id = await issues.idOf(ref);
    if (edit) await issues.edit(id, edit, user);
    return id;
  };
  /** The issue with the seq read once its service has applied its facts: the first frame at that seq shows the change. */
  const applied = async (issue: Promise<T.Issue>): Promise<T.AppliedIssue> => ({ ...(await issue), seq: core.seq() });
  const createOnce = requestKeys<T.AppliedIssue>(deps.clock);
  const statusOnce = requestKeys<T.AppliedIssue>(deps.clock);
  return {
    "issue.conversation.get": async ({ id }) => channels.issueThreadId((await issues.get(id)).id),
    "issue.list": (filter) => issues.query(filter),
    "issue.review": async ({ id: ref, ...body }) => issues.review(await issues.idOf(ref), body),
    "issue.split": async ({ id: ref, ...body }) => issues.split(await issues.idOf(ref), body.title ?? "", body.tasks, user),
    "issue.history.list": () => issues.history(),
    "issue.get": ({ id }) => issues.get(id),
    "issue.run.list": async ({ id }) => issues.runs(id),
    "issue.timeline.get": ({ id }) => issues.timeline(id),
    "issue.create": ({ requestKey, autoSubmitPr, ...body }) =>
      createOnce(requestKey, () =>
        applied(
          (async () => {
            try {
              return (await issues.create({ ...body, by: user, ...(autoSubmitPr !== undefined ? { autoSubmitPr } : {}) })).issue;
            } catch (e) {
              if (e instanceof IssueCreateRefused) throw e.error ?? bizError(BizCode.IssueRefused, e.reason);
              throw e;
            }
          })(),
        ),
      ),
    "issue.update": ({ id: ref, ...body }) => applied((async () => issues.edit(await issues.idOf(ref), body, user))()),
    "issue.delete": async ({ id: ref }) => issues.remove(await issues.idOf(ref)),
    "issue.previewDelete": ({ id }) => issues.previewRemove(id),
    "issue.status.previewUpdate": ({ id, ...body }) =>
      issues.previewStatus(id, body.status, body.text ?? "", body.agent ? { agent: body.agent } : {}, body.edit),
    "issue.refine": async ({ id: ref, ...body }) => issues.refine(await edited(ref, body.edit), body.text ?? "", channels.defaultChannel()),
    "issue.status.update": ({ id: ref, ...body }) =>
      statusOnce(body.requestKey, () =>
        applied(
          (async () =>
            issues.setStatus(
              await edited(ref, body.edit),
              body.status,
              body.text ?? "",
              channels.defaultChannel(),
              user,
              body.agent ? { agent: body.agent } : {},
            ))(),
        ),
      ),
    "issue.comment.create": async ({ id: ref, ...body }): Promise<T.Applied> => {
      await issues.comment(await issues.idOf(ref), body.text, body.sendKey ?? "", user);
      return { seq: core.seq() };
    },
    "issue.diff.get": ({ id }) => issues.changes(id, user),
  };
}
