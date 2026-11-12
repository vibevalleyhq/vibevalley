import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { AgentRoleValues } from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const agentLine = (a: T.Agent) => [a.id, a.name, a.role, a.runtime, a.enabled ? "" : "off"].filter((x) => x !== "").join("  ");

export const agentCommand = group("agent", t("cli.group.agent.about"), [
  command("list", {
    about: t("cli.command.agent.list"),
    examples: [{ command: "vibevalley agent list", description: t("cli.example.agentList.about") }],
    run: async (_, ctx) => show(ctx, await ask(ctx, (api) => api.agent.list()), (as) => as.map(agentLine).join("\n")),
  }),
  command("create", {
    about: t("cli.command.agent.create"),
    examples: [{ command: "vibevalley agent create fox --runtime claude", description: t("cli.example.agentCreate.about") }],
    params: {
      name: arg.text("name", "cli.arg.agentName"),
      runtime: opt.textOr("runtime", "pi", "cli.flag.runtime"),
      role: opt.choiceOr("role", AgentRoleValues, "worker", "cli.flag.role"),
      duty: opt.textOr("duty", "", "cli.flag.duty"),
      model: opt.textOr("model", "", "cli.flag.model"),
      effort: opt.textOr("effort", "", "cli.flag.effort"),
    },
    run: (o, ctx) =>
      change(ctx, {
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
  }),
  command("delete", {
    about: t("cli.command.agent.delete"),
    examples: [{ command: "vibevalley agent delete docs --dry-run", description: t("cli.example.agentDelete.about") }],
    params: { agent: arg.text("agent", "cli.arg.agent") },
    run: (o, ctx) =>
      change(ctx, {
        name: "agent delete",
        preview: (api) => api.agent.previewDelete({ id: o.agent }),
        does: (api) => api.agent.delete({ id: o.agent }),
        said: () => t("cli.agent.deleted", { agent: o.agent }),
      }),
  }),
]);
