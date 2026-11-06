import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, nameArg, show } from "#/farm.ts";

const repoLine = (p: T.RepoSummary) => [p.name, p.path, p.git ? "git" : "", p.pullRequest.available ? "pr" : ""].filter((x) => x !== "").join("  ");

export const repoCommand = Command.make("repo").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.repo.list()),
        (all) => show(all, (ps) => ps.map(repoLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.repo.list")),
      Command.withExamples([{ command: "vibevalley repo list", description: t("cli.example.repoList.about") }]),
    ),
    Command.make(
      "create",
      { name: nameArg("name", "cli.arg.repoName"), repo: Flag.String("repo").pipe(Flag.optional, Flag.withDescription(t("cli.flag.repo"))) },
      (o) => {
        const github = given(o.repo);
        return change({
          name: "repo create",
          does: (api) => api.repo.create({ name: o.name, ...(github === undefined ? {} : { github }) }),
          said: (p) => repoLine(p),
        });
      },
    ).pipe(
      Command.withDescription(t("cli.command.repo.create")),
      Command.withExamples([{ command: "vibevalley repo create web --repo https://github.com/me/web", description: t("cli.example.repoCreate.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.repo.about")),
);
