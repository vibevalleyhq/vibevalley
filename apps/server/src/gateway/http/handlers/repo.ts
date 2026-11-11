import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/http";

import { t } from "@vibevalley/i18n";
import type { RepoHandlers } from "@vibevalley/protocol/api";

import { BizCode, bizError, lookIn, orMissing } from "#/base/errors.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { Repo } from "#/modules/repo/repo.ts";

export const repoHandlers = Effect.gen(function* () {
  const repos = yield* Repo;
  const issues = yield* Issue;
  const done: RepoHandlers = {
    "repo.pr.submit": (body) =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        if (Option.isNone(request) || request.value.headers.authorization !== undefined)
          return yield* bizError(BizCode.RepoRefused, t("server.repo.publish.userOnly"));
        return yield* repos.submitBranch(body).pipe(Effect.mapError((e) => bizError(BizCode.RepoRefused, e.message)));
      }),
    "github.refresh": () => Effect.tap(repos.refreshGitHub(), () => issues.refreshPullRequests),
    "github.get": () => Effect.sync(repos.githubStatus),
    "repo.list": () => repos.summaries(),
    "repo.validate": (body) => Effect.sync(() => repos.validate(body)),
    "repo.create": (body) =>
      repos.create(body).pipe(
        Effect.flatMap(repos.summary),
        Effect.mapError((e) => bizError(BizCode.RepoRefused, e.message)),
      ),
    "repo.language.list": ({ id }) =>
      repos.languages(id).pipe(
        Effect.mapError((e) => bizError(BizCode.RepoRefused, e.message)),
        orMissing(t("server.repoRef", { id }), [lookIn.repo]),
      ),
    "repo.activity.get": ({ id }) => repos.activity(id).pipe(orMissing(t("server.repoRef", { id }), [lookIn.repo])),
    "repo.template.list": ({ id }) => issues.templates(id),
  };
  return done;
});
