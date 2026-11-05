import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, nameArg, show } from "../farm.ts";

const projectLine = (p: T.ProjectSummary) => [p.name, p.path, p.git ? "git" : "", p.pullRequest.available ? "pr" : ""].filter((x) => x !== "").join("  ");

export const projectCommand = Command.make("project").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.project.list()),
        (all) => show(all, (ps) => ps.map(projectLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.project.list")),
      Command.withExamples([{ command: "vibevalley project list", description: t("cli.example.projectList.about") }]),
    ),
    Command.make(
      "create",
      { name: nameArg("name", "cli.arg.projectName"), repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription(t("cli.flag.repo"))) },
      (o) => {
        const github = given(o.repo);
        return change({
          name: "project create",
          does: (api) => api.project.create({ name: o.name, ...(github === undefined ? {} : { github }) }),
          said: (p) => projectLine(p),
        });
      },
    ).pipe(
      Command.withDescription(t("cli.command.project.create")),
      Command.withExamples([{ command: "vibevalley project create web --repo https://github.com/me/web", description: t("cli.example.projectCreate.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.project.about")),
);
