import { Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type { ProjectHandlers } from "@vibevalley/protocol/api";

import { lookIn, refused, orMissing } from "#/base/errors.ts";
import { Issue } from "#/issue/issue.ts";
import { Project } from "#/project/project.ts";

export const projectHandlers = Effect.gen(function* () {
  const projects = yield* Project;
  const issues = yield* Issue;
  const done: ProjectHandlers = {
    "github.refresh": () => Effect.tap(projects.refreshGitHub(), () => issues.refreshPullRequests),
    "github.get": () => Effect.sync(projects.githubStatus),
    "project.list": () => projects.summaries(),
    "project.validate": (body) => Effect.sync(() => projects.validate(body)),
    "project.create": (body) =>
      projects.create(body).pipe(
        Effect.flatMap(projects.summary),
        Effect.mapError((e) => refused(e.message)),
      ),
    "project.language.list": ({ id }) =>
      projects.languages(id).pipe(
        Effect.mapError((e) => refused(e.message)),
        orMissing(t("server.projectRef", { id }), [lookIn.project]),
      ),
    "project.activity.get": ({ id }) => projects.activity(id).pipe(orMissing(t("server.projectRef", { id }), [lookIn.project])),
    "project.template.list": ({ id }) => issues.templates(id),
  };
  return done;
});
