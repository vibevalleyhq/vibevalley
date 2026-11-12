import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const agentArg = arg.text("agent", "cli.arg.agent");

const memoryLine = (m: T.Memory) =>
  [m.id, `@${m.agent}`, m.kind, m.repo === undefined ? "" : `[${m.repo}]`, m.text.replace(/\s+/gu, " ")].filter((x) => x !== "").join("  ");

export const memoryCommand = group("memory", t("cli.group.memory.about"), [
  command("list", {
    about: t("cli.command.memory.list"),
    examples: [{ command: "vibevalley memory list docs", description: t("cli.example.memoryList.about") }],
    params: { agent: agentArg },
    run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.memory.list({ agent: o.agent })), (x) => x.memories.map(memoryLine).join("\n")),
  }),
  command("search", {
    about: t("cli.command.memory.search"),
    examples: [{ command: t("cli.example.memorySearch.run"), description: t("cli.example.memorySearch.about") }],
    params: { words: arg.words("cli.arg.search"), agent: opt.text("agent", "cli.flag.agent"), repo: opt.text("repo", "cli.flag.repo") },
    run: async (o, ctx) => {
      const { agent, repo } = o;
      const found = await ask(ctx, (api) => api.memory.search({ text: o.words.join(" "), ...(agent ? { agent } : {}), ...(repo ? { repo } : {}) }));
      show(ctx, found, (f) => f.found.map(memoryLine).join("\n"));
    },
  }),
  command("create", {
    about: t("cli.command.memory.create"),
    examples: [{ command: t("cli.example.memoryCreate.run"), description: t("cli.example.memoryCreate.about") }],
    params: { agent: agentArg, words: arg.words("cli.arg.memory"), repo: opt.text("repo", "cli.flag.repo"), key: opt.text("key", "cli.flag.key") },
    run: (o, ctx) => {
      const { repo, key: requestKey } = o;
      return change(ctx, {
        name: "memory create",
        does: (api) => api.memory.create({ agent: o.agent, text: o.words.join(" "), ...(repo ? { repo } : {}), ...(requestKey ? { requestKey } : {}) }),
        said: memoryLine,
      });
    },
  }),
  command("delete", {
    about: t("cli.command.memory.delete"),
    examples: [{ command: "vibevalley memory delete docs m1 --dry-run", description: t("cli.example.memoryDelete.about") }],
    params: { agent: agentArg, memory: arg.text("memory", "cli.arg.memoryId") },
    run: (o, ctx) =>
      change(ctx, {
        name: "memory delete",
        preview: (api) => api.memory.previewDelete({ agent: o.agent, memory: o.memory }),
        does: (api) => api.memory.delete({ agent: o.agent, memory: o.memory }),
        said: () => t("cli.memory.deleted", { memory: o.memory }),
      }),
  }),
]);
