import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const runtimeLine = (r: T.RuntimeInfo) =>
  [r.id, r.installation.status === "available" ? `${r.installation.version ?? ""} ${r.installation.command}`.trim() : r.installation.status].join("  ");

export const runtimeCommand = group("runtime", t("cli.group.runtime.about"), [
  command("list", {
    about: t("cli.command.runtime.list"),
    examples: [{ command: "vibevalley runtime list", description: t("cli.example.runtimeList.about") }],
    run: async (_, ctx) => show(ctx, await ask(ctx, (api) => api.runtime.list()), (rs) => rs.map(runtimeLine).join("\n")),
  }),
  command("refresh", {
    about: t("cli.command.runtime.refresh"),
    examples: [{ command: "vibevalley runtime refresh claude", description: t("cli.example.runtimeRefresh.about") }],
    params: { runtime: arg.text("runtime", "cli.arg.runtime") },
    run: (o, ctx) => change(ctx, { name: "runtime refresh", does: (api) => api.runtime.refresh({ id: o.runtime }), said: runtimeLine }),
  }),
]);
