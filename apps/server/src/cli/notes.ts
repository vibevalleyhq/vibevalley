// `vibevalley memory …`, `vibevalley cron …`, `vibevalley artifact …`: what profiles remember, what the farm does on a
// clock, and the drafts (稿子) its helpers and the owner write.

import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { channelNamed } from "./channel.ts";
import { ask, change, given, show } from "./farm.ts";
import { exit, Failure } from "./output.ts";

const words = Argument.String("words").pipe(Argument.variadic(), Argument.withDescription(t("server.cli.arg.words")));
const optionalText = (name: string, about: Parameters<typeof t>[0]) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(t(about)));

const memoryLine = (m: T.Memory) =>
  [m.id, `@${m.agent}`, m.kind, m.project === undefined ? "" : `[${m.project}]`, m.text.replace(/\s+/gu, " ")].filter((x) => x !== "").join("  ");

const memoryGroup = Command.make("memory").pipe(
  Command.withSubcommands([
    Command.make(
      "search",
      { words, agent: optionalText("agent", "server.cli.flag.agent"), project: optionalText("project", "server.cli.flag.project") },
      (o) => {
        const agent = given(o.agent);
        const project = given(o.project);
        return Effect.flatMap(
          ask((api) => api.memory.search({ text: o.words.join(" "), ...(agent ? { agent } : {}), ...(project ? { project } : {}) })),
          (found) => show(found, (f) => f.found.map(memoryLine).join("\n")),
        );
      },
    ).pipe(
      Command.withDescription(t("server.cli.command.memory.search")),
      Command.withExamples([{ command: t("server.cli.example.memorySearch.run"), description: t("server.cli.example.memorySearch.about") }]),
    ),
    Command.make(
      "add",
      {
        agent: Argument.String("agent").pipe(Argument.withDescription(t("server.cli.arg.agent"))),
        words,
        project: optionalText("project", "server.cli.flag.project"),
        key: optionalText("key", "server.cli.flag.key"),
      },
      (o) => {
        const project = given(o.project);
        const requestKey = given(o.key);
        return change({
          name: "memory add",
          does: (api) => api.memory.create({ agent: o.agent, text: o.words.join(" "), ...(project ? { project } : {}), ...(requestKey ? { requestKey } : {}) }),
          said: memoryLine,
        });
      },
    ).pipe(
      Command.withDescription(t("server.cli.command.memory.add")),
      Command.withExamples([{ command: t("server.cli.example.memoryAdd.run"), description: t("server.cli.example.memoryAdd.about") }]),
    ),
  ]),
  Command.withDescription(t("server.cli.group.memory.about")),
);

const whenText = (w: T.CronWhen) => {
  switch (w.kind) {
    case "once":
      return `once ${new Date(w.at).toISOString()}`;
    case "every":
      return `every ${w.minutes}m`;
    case "daily":
      return `daily ${w.time}`;
    case "weekly":
      return `weekly ${w.days.join(",")} ${w.time}`;
    case "cron":
      return `cron ${w.expr}`;
  }
};

const cronLine = (c: T.Cron) => [c.id, c.name, whenText(c.when), c.enabled ? "" : "off", c.text.replace(/\s+/gu, " ")].filter((x) => x !== "").join("  ");

/** When, from the one flag given of --every, --daily, --cron, --at; none or two is refused. */
const whenOf = (o: { every: number | undefined; daily: string | undefined; cron: string | undefined; at: string | undefined }) => {
  const given_: T.CronWhen[] = [
    ...(o.every === undefined ? [] : [{ kind: "every" as const, minutes: o.every }]),
    ...(o.daily === undefined ? [] : [{ kind: "daily" as const, time: o.daily }]),
    ...(o.cron === undefined ? [] : [{ kind: "cron" as const, expr: o.cron }]),
    ...(o.at === undefined ? [] : [{ kind: "once" as const, at: Date.parse(o.at) }]),
  ];
  const [one] = given_;
  return given_.length === 1 && one !== undefined
    ? Effect.succeed(one)
    : Effect.fail(
        new Failure({
          code: exit.usage,
          tag: "InvalidValue",
          text: t("server.cli.cron.when"),
          next: [{ say: t("server.cli.next.help"), run: ["cron", "add", "--help"] }],
        }),
      );
};

const cronGroup = Command.make("cron").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.cron.list()),
        (all) => show(all, (cs) => cs.map(cronLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("server.cli.command.cron.list")),
      Command.withExamples([{ command: "vibevalley cron list", description: t("server.cli.example.cronList.about") }]),
    ),
    Command.make(
      "add",
      {
        name: Argument.String("name").pipe(Argument.withDescription(t("server.cli.arg.cronName"))),
        words,
        every: Flag.Int("every").pipe(Flag.optional, Flag.withDescription(t("server.cli.flag.every"))),
        daily: optionalText("daily", "server.cli.flag.daily"),
        cron: optionalText("cron", "server.cli.flag.cronExpr"),
        at: optionalText("at", "server.cli.flag.at"),
        channel: optionalText("channel", "server.cli.flag.channel"),
        agent: optionalText("agent", "server.cli.flag.agent"),
        project: optionalText("project", "server.cli.flag.project"),
      },
      (o) =>
        Effect.gen(function* () {
          const when = yield* whenOf({ every: given(o.every), daily: given(o.daily), cron: given(o.cron), at: given(o.at) });
          const named = given(o.channel);
          const channel = named === undefined ? undefined : (yield* channelNamed(named)).id;
          const agent = given(o.agent);
          const project = given(o.project);
          yield* change({
            name: "cron add",
            does: (api) =>
              api.cron.create({
                name: o.name,
                text: o.words.join(" "),
                when,
                ...(channel ? { channel } : {}),
                ...(agent ? { agent } : {}),
                ...(project ? { project } : {}),
              }),
            said: cronLine,
          });
        }),
    ).pipe(
      Command.withDescription(t("server.cli.command.cron.add")),
      Command.withExamples([{ command: t("server.cli.example.cronAdd.run"), description: t("server.cli.example.cronAdd.about") }]),
    ),
    Command.make("remove", { cron: Argument.String("cron").pipe(Argument.withDescription(t("server.cli.arg.cron"))) }, (o) =>
      change({
        name: "cron remove",
        preview: (api) => api.cron.previewDelete({ id: o.cron }),
        does: (api) => api.cron.delete({ id: o.cron }),
        said: () => t("server.cli.cron.removed", { cron: o.cron }),
      }),
    ).pipe(
      Command.withDescription(t("server.cli.command.cron.remove")),
      Command.withExamples([{ command: "vibevalley cron remove c1 --dry-run", description: t("server.cli.example.cronRemove.about") }]),
    ),
  ]),
  Command.withDescription(t("server.cli.group.cron.about")),
);

const artifactLine = (a: T.Artifact) =>
  [a.id, a.title, a.body, `@${a.byName}`, a.issue === undefined ? "" : `issue ${a.issue}`].filter((x) => x !== "").join("  ");
const artifactArg = Argument.String("artifact").pipe(Argument.withDescription(t("server.cli.arg.artifact")));

const artifactGroup = Command.make("artifact").pipe(
  Command.withSubcommands([
    Command.make("list", { issue: optionalText("issue", "server.cli.flag.issue") }, (o) => {
      const issue = given(o.issue);
      return Effect.flatMap(
        ask((api) => api.artifact.list(issue ? { issue: issue.replace(/^#/u, "") } : {})),
        (all) => show(all, (as) => as.map(artifactLine).join("\n")),
      );
    }).pipe(
      Command.withDescription(t("server.cli.command.artifact.list")),
      Command.withExamples([{ command: "vibevalley artifact list --issue 12", description: t("server.cli.example.artifactList.about") }]),
    ),
    Command.make("show", { artifact: artifactArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.artifact.get({ id: artifactId(o.artifact) })),
        (a) => show(a, artifactLine),
      ),
    ).pipe(
      Command.withDescription(t("server.cli.command.artifact.show")),
      Command.withExamples([{ command: "vibevalley artifact show a1", description: t("server.cli.example.artifactShow.about") }]),
    ),
    Command.make("read", { artifact: artifactArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.artifact.content.get({ id: artifactId(o.artifact) })),
        (c) => show(c, (x) => x.content),
      ),
    ).pipe(
      Command.withDescription(t("server.cli.command.artifact.read")),
      Command.withExamples([{ command: "vibevalley artifact read a1", description: t("server.cli.example.artifactRead.about") }]),
    ),
  ]),
  Command.withDescription(t("server.cli.group.artifact.about")),
);

export const keptCommands = [memoryGroup, cronGroup, artifactGroup];
