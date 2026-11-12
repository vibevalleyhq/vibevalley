import { t } from "@vibevalley/i18n";
import type { RepoHandlers } from "@vibevalley/protocol/api";

import { BizCode, bizError, lookIn, orMissing } from "#/base/errors.ts";
import { requestHeaders } from "#/gateway/http/api.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { RepoError } from "#/modules/repo/workplace.ts";

/** A repo's own failure as the caller's refusal; anything else stays what it is. */
const asRefusal = (e: unknown): unknown => (e instanceof RepoError ? bizError(BizCode.RepoRefused, e.message) : e);

export function repoHandlers(deps: { readonly repo: Repo; readonly issue: Issue }): RepoHandlers {
  const { repo: repos, issue: issues } = deps;
  return {
    "repo.pr.submit": async (body) => {
      const headers = requestHeaders();
      if (headers === undefined || headers.get("authorization") !== null) throw bizError(BizCode.RepoRefused, t("server.repo.publish.userOnly"));
      try {
        return await repos.submitBranch(body);
      } catch (e) {
        throw asRefusal(e);
      }
    },
    "github.refresh": async () => {
      const status = await repos.refreshGitHub();
      await issues.refreshPullRequests();
      return status;
    },
    "github.get": async () => repos.githubStatus(),
    "repo.list": () => repos.summaries(),
    "repo.validate": async (body) => repos.validate(body),
    "repo.create": async (body) => {
      try {
        return await repos.summary(await repos.create(body));
      } catch (e) {
        throw asRefusal(e);
      }
    },
    "repo.language.list": async ({ id }) => {
      let found;
      try {
        found = await repos.languages(id);
      } catch (e) {
        throw asRefusal(e);
      }
      return orMissing(t("server.repoRef", { id }), [lookIn.repo])(found);
    },
    "repo.activity.get": async ({ id }) => orMissing(t("server.repoRef", { id }), [lookIn.repo])(await repos.activity(id)),
    "repo.template.list": ({ id }) => issues.templates(id),
  };
}
