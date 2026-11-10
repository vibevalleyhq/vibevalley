import { Effect } from "effect";
import { Command } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, nameArg } from "#/farm.ts";
import { show } from "#/format.ts";

const runtimeLine = (r: T.RuntimeInfo) =>
  [r.id, r.installation.status === "available" ? `${r.installation.version ?? ""} ${r.installation.command}`.trim() : r.installation.status].join("  ");

export const runtimeCommand = Command.make("runtime").pipe(
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
