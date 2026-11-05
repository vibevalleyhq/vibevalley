import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { ask, change, given, show } from "./farm.ts";
import { exit, Failure } from "./output.ts";

const words = (about: Parameters<typeof t>[0]) => Argument.String("words").pipe(Argument.variadic({ min: 1 }), Argument.withDescription(t(about)));
const optionalText = (name: string, about: Parameters<typeof t>[0]) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(t(about)));
const agentArg = Argument.String("agent").pipe(Argument.withDescription(t("cli.arg.agent")));

const memoryLine = (m: T.Memory) =>
  [m.id, `@${m.agent}`, m.kind, m.project === undefined ? "" : `[${m.project}]`, m.text.replace(/\s+/gu, " ")].filter((x) => x !== "").join("  ");

const memoryGroup = Command.make("memory").pipe(
  Command.withSubcommands([
    Command.make("list", { agent: agentArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.memory.list({ agent: o.agent })),
        (l) => show(l, (x) => x.memories.map(memoryLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.memory.list")),
      Command.withExamples([{ command: "vibevalley memory list docs", description: t("cli.example.memoryList.about") }]),
    ),
    Command.make(
      "search",
      { words: words("cli.arg.search"), agent: optionalText("agent", "cli.flag.agent"), project: optionalText("project", "cli.flag.project") },
      (o) => {
        const agent = given(o.agent);
        const project = given(o.project);
        return Effect.flatMap(
          ask((api) => api.memory.search({ text: o.words.join(" "), ...(agent ? { agent } : {}), ...(project ? { project } : {}) })),
          (found) => show(found, (f) => f.found.map(memoryLine).join("\n")),
        );
      },
    ).pipe(
      Command.withDescription(t("cli.command.memory.search")),
      Command.withExamples([{ command: t("cli.example.memorySearch.run"), description: t("cli.example.memorySearch.about") }]),
    ),
    Command.make(
      "create",
      { agent: agentArg, words: words("cli.arg.memory"), project: optionalText("project", "cli.flag.project"), key: optionalText("key", "cli.flag.key") },
      (o) => {
        const project = given(o.project);
        const requestKey = given(o.key);
        return change({
          name: "memory create",
          does: (api) => api.memory.create({ agent: o.agent, text: o.words.join(" "), ...(project ? { project } : {}), ...(requestKey ? { requestKey } : {}) }),
          said: memoryLine,
        });
      },
    ).pipe(
      Command.withDescription(t("cli.command.memory.create")),
      Command.withExamples([{ command: t("cli.example.memoryCreate.run"), description: t("cli.example.memoryCreate.about") }]),
    ),
    Command.make("delete", { agent: agentArg, memory: Argument.String("memory").pipe(Argument.withDescription(t("cli.arg.memoryId"))) }, (o) =>
      change({
        name: "memory delete",
        preview: (api) => api.memory.previewDelete({ agent: o.agent, memory: o.memory }),
        does: (api) => api.memory.delete({ agent: o.agent, memory: o.memory }),
        said: () => t("cli.memory.deleted", { memory: o.memory }),
      }),
    ).pipe(
      Command.withDescription(t("cli.command.memory.delete")),
      Command.withExamples([{ command: "vibevalley memory delete docs m1 --dry-run", description: t("cli.example.memoryDelete.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.memory.about")),
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
          text: t("cli.cron.when"),
          next: [{ say: t("cli.next.help"), run: ["cron", "new", "--help"] }],
        }),
      );
};

const cronArg = Argument.String("cron").pipe(Argument.withDescription(t("cli.arg.cron")));

const cronGroup = Command.make("cron").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.flatMap(
        ask((api) => api.cron.list()),
        (all) => show(all, (cs) => cs.map(cronLine).join("\n")),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.cron.list")),
      Command.withExamples([{ command: "vibevalley cron list", description: t("cli.example.cronList.about") }]),
    ),
    Command.make(
      "create",
      {
        name: Argument.String("name").pipe(Argument.withDescription(t("cli.arg.cronName"))),
        words: words("cli.arg.cronText"),
        every: Flag.Int("every").pipe(Flag.optional, Flag.withDescription(t("cli.flag.every"))),
        daily: optionalText("daily", "cli.flag.daily"),
        cron: optionalText("cron", "cli.flag.cronExpr"),
        at: optionalText("at", "cli.flag.at"),
        channel: optionalText("channel", "cli.flag.channel"),
        agent: optionalText("agent", "cli.flag.agent"),
        project: optionalText("project", "cli.flag.project"),
      },
      (o) =>
        Effect.gen(function* () {
          const when = yield* whenOf({ every: given(o.every), daily: given(o.daily), cron: given(o.cron), at: given(o.at) });
          const fields = { channel: given(o.channel), agent: given(o.agent), project: given(o.project) };
          yield* change({
            name: "cron create",
            does: (api) =>
              api.cron.create({
                name: o.name,
                text: o.words.join(" "),
                when,
                ...(fields.channel ? { channel: fields.channel } : {}),
                ...(fields.agent ? { agent: fields.agent } : {}),
                ...(fields.project ? { project: fields.project } : {}),
              }),
            said: cronLine,
          });
        }),
    ).pipe(
      Command.withDescription(t("cli.command.cron.create")),
      Command.withExamples([{ command: t("cli.example.cronCreate.run"), description: t("cli.example.cronCreate.about") }]),
    ),
    Command.make(
      "edit",
      { cron: cronArg, enabled: Flag.Literals("enabled", ["true", "false"] as const).pipe(Flag.withDescription(t("cli.flag.enabled"))) },
      (o) =>
        change({
          name: "cron edit",
          does: (api) => api.cron.update({ id: o.cron, enabled: o.enabled === "true" }),
          said: () => t("cli.cron.edited", { cron: o.cron }),
        }),
    ).pipe(
      Command.withDescription(t("cli.command.cron.edit")),
      Command.withExamples([{ command: "vibevalley cron edit c1 --enabled false", description: t("cli.example.cronEdit.about") }]),
    ),
    Command.make("delete", { cron: cronArg }, (o) =>
      change({
        name: "cron delete",
        preview: (api) => api.cron.previewDelete({ id: o.cron }),
        does: (api) => api.cron.delete({ id: o.cron }),
        said: () => t("cli.cron.deleted", { cron: o.cron }),
      }),
    ).pipe(
      Command.withDescription(t("cli.command.cron.delete")),
      Command.withExamples([{ command: "vibevalley cron delete c1 --dry-run", description: t("cli.example.cronDelete.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.cron.about")),
);

const artifactLine = (a: T.Artifact) =>
  [a.id, a.title, a.body, `@${a.byName}`, a.issue === undefined ? "" : `issue ${a.issue}`].filter((x) => x !== "").join("  ");
const artifactArg = Argument.String("artifact").pipe(Argument.withDescription(t("cli.arg.artifact")));

const artifactGroup = Command.make("artifact").pipe(
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
        ask((api) => api.artifact.get({ id: artifactId(o.artifact) })),
        (a) => show(a, artifactLine),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.artifact.show")),
      Command.withExamples([{ command: "vibevalley artifact show a1", description: t("cli.example.artifactShow.about") }]),
    ),
    Command.make("read", { artifact: artifactArg }, (o) =>
      Effect.flatMap(
        ask((api) => api.artifact.content.get({ id: artifactId(o.artifact) })),
        (c) => show(c, (x) => x.content),
      ),
    ).pipe(
      Command.withDescription(t("cli.command.artifact.read")),
      Command.withExamples([{ command: "vibevalley artifact read a1", description: t("cli.example.artifactRead.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.artifact.about")),
);

export const keptCommands = [memoryGroup, cronGroup, artifactGroup];
