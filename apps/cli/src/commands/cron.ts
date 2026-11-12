import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { exit, Failure } from "#/base/output.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

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
const whenOf = (o: { every: number | undefined; daily: string | undefined; cron: string | undefined; at: string | undefined }): T.CronWhen => {
  const given: T.CronWhen[] = [
    ...(o.every === undefined ? [] : [{ kind: "every" as const, minutes: o.every }]),
    ...(o.daily === undefined ? [] : [{ kind: "daily" as const, time: o.daily }]),
    ...(o.cron === undefined ? [] : [{ kind: "cron" as const, expr: o.cron }]),
    ...(o.at === undefined ? [] : [{ kind: "once" as const, at: Date.parse(o.at) }]),
  ];
  const [one] = given;
  if (given.length === 1 && one !== undefined) return one;
  throw new Failure({
    code: exit.usage,
    tag: "InvalidValue",
    text: t("cli.cron.when"),
    next: [{ say: t("cli.next.help"), run: ["cron", "new", "--help"] }],
  });
};

const cronArg = arg.text("cron", "cli.arg.cron");

export const cronCommand = group("cron", t("cli.group.cron.about"), [
  command("list", {
    about: t("cli.command.cron.list"),
    examples: [{ command: "vibevalley cron list", description: t("cli.example.cronList.about") }],
    run: async (_, ctx) => show(ctx, await ask(ctx, (api) => api.cron.list()), (cs) => cs.map(cronLine).join("\n")),
  }),
  command("create", {
    about: t("cli.command.cron.create"),
    examples: [{ command: t("cli.example.cronCreate.run"), description: t("cli.example.cronCreate.about") }],
    params: {
      name: arg.text("name", "cli.arg.cronName"),
      words: arg.words("cli.arg.cronText"),
      every: opt.int("every", "cli.flag.every"),
      daily: opt.text("daily", "cli.flag.daily"),
      cron: opt.text("cron", "cli.flag.cronExpr"),
      at: opt.text("at", "cli.flag.at"),
      channel: opt.text("channel", "cli.flag.channel"),
      agent: opt.text("agent", "cli.flag.agent"),
      repo: opt.text("repo", "cli.flag.repo"),
    },
    run: (o, ctx) => {
      const when = whenOf({ every: o.every, daily: o.daily, cron: o.cron, at: o.at });
      return change(ctx, {
        name: "cron create",
        does: (api) =>
          api.cron.create({
            name: o.name,
            text: o.words.join(" "),
            when,
            ...(o.channel ? { channel: o.channel } : {}),
            ...(o.agent ? { agent: o.agent } : {}),
            ...(o.repo ? { repo: o.repo } : {}),
          }),
        said: cronLine,
      });
    },
  }),
  command("edit", {
    about: t("cli.command.cron.edit"),
    examples: [{ command: "vibevalley cron edit c1 --enabled false", description: t("cli.example.cronEdit.about") }],
    params: { cron: cronArg, enabled: opt.requiredChoice("enabled", ["true", "false"], "cli.flag.enabled") },
    run: (o, ctx) =>
      change(ctx, {
        name: "cron edit",
        does: (api) => api.cron.update({ id: o.cron, enabled: o.enabled === "true" }),
        said: () => t("cli.cron.edited", { cron: o.cron }),
      }),
  }),
  command("delete", {
    about: t("cli.command.cron.delete"),
    examples: [{ command: "vibevalley cron delete c1 --dry-run", description: t("cli.example.cronDelete.about") }],
    params: { cron: cronArg },
    run: (o, ctx) =>
      change(ctx, {
        name: "cron delete",
        preview: (api) => api.cron.previewDelete({ id: o.cron }),
        does: (api) => api.cron.delete({ id: o.cron }),
        said: () => t("cli.cron.deleted", { cron: o.cron }),
      }),
  }),
]);
