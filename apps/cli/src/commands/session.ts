import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, nameArg, show } from "#/farm.ts";

const sessionLine = (s: T.Session) =>
  [s.id, s.name, `@${s.agent}`, s.phase._tag, s.issue === undefined ? "" : `issue ${s.issue}`, s.repo === undefined ? "" : `[${s.repo}]`]
    .filter((x) => x !== "")
    .join("  ");

const sessionArg = nameArg("session", "cli.arg.session");

export const sessionCommand = Command.make("session").pipe(
  Command.withSubcommands([
    Command.make("list", { agent: Flag.String("agent").pipe(Flag.optional, Flag.withDescription(t("cli.flag.agent"))) }, (o) => {
      const agent = given(o.agent);
      return Effect.flatMap(
        ask((api) => api.session.list(agent === undefined ? {} : { agent })),
        (all) => show(all, (ss) => ss.map(sessionLine).join("\n")),
      );
    }).pipe(
      Command.withDescription(t("cli.command.session.list")),
      Command.withExamples([{ command: "vibevalley session list", description: t("cli.example.sessionList.about") }]),
    ),
    Command.make("show", { session: sessionArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.session.get({ id: o.session })),
        (s) => show(s, (x) => [sessionLine(x), x.brief.split("\n")[0] ?? "", x.worktree ?? ""].filter((l) => l !== "").join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.session.show")),
      Command.withExamples([{ command: "vibevalley session show w3", description: t("cli.example.sessionShow.about") }]),
    ),
    Command.make("stop", { session: sessionArg }, (o) =>
      change({ name: "session stop", does: (api) => api.session.stop({ id: o.session }), said: () => t("cli.session.stopped", { session: o.session }) }),
    ).pipe(
      Command.withDescription(t("cli.command.session.stop")),
      Command.withExamples([{ command: "vibevalley session stop w3", description: t("cli.example.sessionStop.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.session.about")),
);
