import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { AgentRoleValues } from "@vibevalley/protocol";

import { ask, change, nameArg } from "#/farm.ts";
import { show } from "#/format.ts";

const agentLine = (a: T.Agent) => [a.id, a.name, a.role, a.runtime, a.enabled ? "" : "off"].filter((x) => x !== "").join("  ");

export const agentCommand = Command.make("agent").pipe(
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
    Command.make(
      "create",
      {
        name: nameArg("name", "cli.arg.agentName"),
        runtime: Flag.String("runtime").pipe(Flag.withDefault("pi"), Flag.withDescription(t("cli.flag.runtime"))),
        role: Flag.Literals("role", AgentRoleValues).pipe(Flag.withDefault("worker" as const), Flag.withDescription(t("cli.flag.role"))),
        duty: Flag.String("duty").pipe(Flag.withDefault(""), Flag.withDescription(t("cli.flag.duty"))),
        model: Flag.String("model").pipe(Flag.withDefault(""), Flag.withDescription(t("cli.flag.model"))),
        effort: Flag.String("effort").pipe(Flag.withDefault(""), Flag.withDescription(t("cli.flag.effort"))),
      },
      (o) =>
        change({
          name: "agent create",
          does: (api) =>
            api.agent.create({
              id: "",
              name: o.name,
              role: o.role,
              duty: o.duty,
              enabled: true,
              runtime: o.runtime,
              model: o.model,
              effort: o.effort,
              persona: "",
              personaMode: "append",
              skills: [],
              mcpServers: [],
              disallowedTools: [],
              env: {},
              workdir: "",
              worktree: true,
              tags: [],
              look: { orchestrator: null, species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
            }),
          said: agentLine,
        }),
    ).pipe(
      Command.withDescription(t("cli.command.agent.create")),
      Command.withExamples([{ command: "vibevalley agent create fox --runtime claude", description: t("cli.example.agentCreate.about") }]),
    ),
    Command.make("delete", { agent: nameArg("agent", "cli.arg.agent") }, (o) =>
      change({
        name: "agent delete",
        preview: (api) => api.agent.previewDelete({ id: o.agent }),
        does: (api) => api.agent.delete({ id: o.agent }),
        said: () => t("cli.agent.deleted", { agent: o.agent }),
      }),
    ).pipe(
      Command.withDescription(t("cli.command.agent.delete")),
      Command.withExamples([{ command: "vibevalley agent delete docs --dry-run", description: t("cli.example.agentDelete.about") }]),
    ),
  ]),
  Command.withDescription(t("cli.group.agent.about")),
);
