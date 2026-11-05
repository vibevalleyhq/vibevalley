import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ArtifactId } from "@vibevalley/protocol/schema";

import { ask, given, optionalText, show } from "../farm.ts";

const artifactLine = (a: T.Artifact) =>
  [a.id, a.title, a.body, `@${a.byName}`, a.issue === undefined ? "" : `issue ${a.issue}`].filter((x) => x !== "").join("  ");
const artifactArg = Argument.String("artifact").pipe(Argument.withSchema(ArtifactId), Argument.withDescription(t("cli.arg.artifact")));

export const artifactCommand = Command.make("artifact").pipe(
  Command.withSubcommands([
    Command.make("list", { issue: optionalText("issue", "cli.flag.issue") }, (o) => {
      const issue = given(o.issue);
      return Effect.flatMap(
        ask((api) => api.artifact.list(issue ? { issue: issue.replace(/^#/u, "") } : {})),
        (all) => show(all, (as) => as.map(artifactLine).join("\n")),
      );
    }).pipe(
      Command.withDescription(t("cli.command.artifact.list")),
      Command.withExamples([{ command: "vibevalley artifact list --issue 12", description: t("cli.example.artifactList.about") }]),
    ),
    Command.make("show", { artifact: artifactArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.artifact.get({ id: o.artifact })),
        (a) => show(a, artifactLine),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.artifact.show")),
      Command.withExamples([{ command: "vibevalley artifact show a1", description: t("cli.example.artifactShow.about") }]),
    ),
    Command.make("read", { artifact: artifactArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.artifact.content.get({ id: o.artifact })),
        (c) => show(c, (x) => x.content),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.artifact.read")),
      Command.withExamples([{ command: "vibevalley artifact read a1", description: t("cli.example.artifactRead.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.artifact.about")),
);
