import { Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type { RepoHandlers } from "@vibevalley/protocol/api";

import { lookIn, refused, orMissing } from "#/base/errors.ts";
import { Issue } from "#/issue/issue.ts";
import { Repo } from "#/repo/repo.ts";

export const repoHandlers = Effect.gen(function* () {
  const repos = yield* Repo;
  const issues = yield* Issue;
  const done: RepoHandlers = {
    "github.refresh": () => Effect.tap(repos.refreshGitHub(), () => issues.refreshPullRequests),
    "github.get": () => Effect.sync(repos.githubStatus),
    "repo.list": () => repos.summaries(),
    "repo.validate": (body) => Effect.sync(() => repos.validate(body)),
    "repo.create": (body) =>
      repos.create(body).pipe(
        Effect.flatMap(repos.summary),
        Effect.mapError((e) => refused(e.message)),
      ),
    "repo.language.list": ({ id }) =>
      repos.languages(id).pipe(
        Effect.mapError((e) => refused(e.message)),
        orMissing(t("server.repoRef", { id }), [lookIn.repo]),
      ),
    "repo.activity.get": ({ id }) => repos.activity(id).pipe(orMissing(t("server.repoRef", { id }), [lookIn.repo])),
    "repo.template.list": ({ id }) => issues.templates(id),
  };
  return done;
});
