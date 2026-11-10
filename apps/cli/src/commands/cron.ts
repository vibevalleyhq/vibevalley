import { DateTime, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, nameArg, optionalText, words } from "#/farm.ts";
import { show } from "#/format.ts";
import { exit, Failure } from "#/output.ts";

const whenText = (w: T.CronWhen) => {
  switch (w.kind) {
    case "once":
      return `once ${DateTime.formatIso(DateTime.makeUnsafe(w.at))}`;
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
        Failure.make({
          code: exit.usage,
          tag: "InvalidValue",
          text: t("cli.cron.when"),
          next: [{ say: t("cli.next.help"), run: ["cron", "new", "--help"] }],
        }),
      );
};

const cronArg = nameArg("cron", "cli.arg.cron");

export const cronCommand = Command.make("cron").pipe(
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
        name: nameArg("name", "cli.arg.cronName"),
        words: words("cli.arg.cronText"),
        every: Flag.Int("every").pipe(Flag.optional, Flag.withDescription(t("cli.flag.every"))),
        daily: optionalText("daily", "cli.flag.daily"),
        cron: optionalText("cron", "cli.flag.cronExpr"),
        at: optionalText("at", "cli.flag.at"),
        channel: optionalText("channel", "cli.flag.channel"),
        agent: optionalText("agent", "cli.flag.agent"),
        repo: optionalText("repo", "cli.flag.repo"),
      },
      (o) =>
        Effect.gen(function* () {
          const when = yield* whenOf({ every: given(o.every), daily: given(o.daily), cron: given(o.cron), at: given(o.at) });
          const fields = { channel: given(o.channel), agent: given(o.agent), repo: given(o.repo) };
          yield* change({
            name: "cron create",
            does: (api) =>
              api.cron.create({
                name: o.name,
                text: o.words.join(" "),
                when,
                ...(fields.channel ? { channel: fields.channel } : {}),
                ...(fields.agent ? { agent: fields.agent } : {}),
                ...(fields.repo ? { repo: fields.repo } : {}),
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
