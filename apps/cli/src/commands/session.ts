import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const sessionLine = (s: T.Session) =>
  [s.id, s.name, `@${s.agent}`, s.phase._tag, s.issue === undefined ? "" : `issue ${s.issue}`, s.repo === undefined ? "" : `[${s.repo}]`]
    .filter((x) => x !== "")
    .join("  ");

const sessionArg = arg.text("session", "cli.arg.session");

export const sessionCommand = group("session", t("cli.group.session.about"), [
  command("list", {
    about: t("cli.command.session.list"),
    examples: [{ command: "vibevalley session list", description: t("cli.example.sessionList.about") }],
    params: { agent: opt.text("agent", "cli.flag.agent") },
    run: async (o, ctx) => {
      const agent = o.agent;
      const all = await ask(ctx, (api) => api.session.list(agent === undefined ? {} : { agent }));
      show(ctx, all, (ss) => ss.map(sessionLine).join("\n"));
    },
  }),
  command("show", {
    about: t("cli.command.session.show"),
    examples: [{ command: "vibevalley session show w3", description: t("cli.example.sessionShow.about") }],
    params: { session: sessionArg },
    run: async (o, ctx) =>
      show(ctx, await ask(ctx, (api) => api.session.get({ id: o.session })), (x) =>
        [sessionLine(x), x.brief.split("\n")[0] ?? "", x.worktree ?? ""].filter((l) => l !== "").join("\n"),
      ),
  }),
  command("stop", {
    about: t("cli.command.session.stop"),
    examples: [{ command: "vibevalley session stop w3", description: t("cli.example.sessionStop.about") }],
    params: { session: sessionArg },
    run: (o, ctx) =>
      change(ctx, { name: "session stop", does: (api) => api.session.stop({ id: o.session }), said: () => t("cli.session.stopped", { session: o.session }) }),
  }),
]);
