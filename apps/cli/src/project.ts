import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, show } from "./farm.ts";

const nameArg = (name: string, about: Parameters<typeof t>[0]) => Argument.String(name).pipe(Argument.withDescription(t(about)));

const projectLine = (p: T.ProjectSummary) => [p.name, p.path, p.git ? "git" : "", p.pullRequest.available ? "pr" : ""].filter((x) => x !== "").join("  ");

const projectGroup = Command.make("project").pipe(
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

const agentLine = (a: T.Agent) => [a.id, a.name, a.role, a.runtime, a.enabled ? "" : "off"].filter((x) => x !== "").join("  ");

const agentGroup = Command.make("agent").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.agent.list()),
        (all) => show(all, (as) => as.map(agentLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.agent.list")),
      Command.withExamples([{ command: "vibevalley agent list", description: t("cli.example.agentList.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.agent.about")),
);

const sessionLine = (s: T.Session) =>
  [s.id, s.name, `@${s.agent}`, s.phase._tag, s.issue === undefined ? "" : `issue ${s.issue}`, s.project === undefined ? "" : `[${s.project}]`]
    .filter((x) => x !== "")
    .join("  ");

const sessionArg = nameArg("session", "cli.arg.session");

const sessionGroup = Command.make("session").pipe(
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

const runtimeLine = (r: T.RuntimeInfo) =>
  [r.id, r.installation.status === "available" ? `${r.installation.version ?? ""} ${r.installation.command}`.trim() : r.installation.status].join("  ");

const runtimeGroup = Command.make("runtime").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.runtime.list()),
        (all) => show(all, (rs) => rs.map(runtimeLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.runtime.list")),
      Command.withExamples([{ command: "vibevalley runtime list", description: t("cli.example.runtimeList.about") }]),
    ),
    Command.make("refresh", { runtime: nameArg("runtime", "cli.arg.runtime") }, (o) =>
      change({ name: "runtime refresh", does: (api) => api.runtime.refresh({ id: o.runtime }), said: runtimeLine }),
    ).pipe(
      Command.withDescription(t("cli.command.runtime.refresh")),
      Command.withExamples([{ command: "vibevalley runtime refresh claude", description: t("cli.example.runtimeRefresh.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.runtime.about")),
);

export const farmPartCommands = [projectGroup, agentGroup, sessionGroup, runtimeGroup];
