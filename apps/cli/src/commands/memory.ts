import { Effect } from "effect";
import { Command } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, nameArg, optionalText, words } from "#/farm.ts";
import { show } from "#/format.ts";

const agentArg = nameArg("agent", "cli.arg.agent");

const memoryLine = (m: T.Memory) =>
  [m.id, `@${m.agent}`, m.kind, m.repo === undefined ? "" : `[${m.repo}]`, m.text.replace(/\s+/gu, " ")].filter((x) => x !== "").join("  ");

export const memoryCommand = Command.make("memory").pipe(
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
      { words: words("cli.arg.search"), agent: optionalText("agent", "cli.flag.agent"), repo: optionalText("repo", "cli.flag.repo") },
      (o) => {
        const agent = given(o.agent);
        const repo = given(o.repo);
        return Effect.flatMap(
          ask((api) => api.memory.search({ text: o.words.join(" "), ...(agent ? { agent } : {}), ...(repo ? { repo } : {}) })),
          (found) => show(found, (f) => f.found.map(memoryLine).join("\n")),
        );
      },
    ).pipe(
      Command.withDescription(t("cli.command.memory.search")),
      Command.withExamples([{ command: t("cli.example.memorySearch.run"), description: t("cli.example.memorySearch.about") }]),
    ),
    Command.make(
      "create",
      { agent: agentArg, words: words("cli.arg.memory"), repo: optionalText("repo", "cli.flag.repo"), key: optionalText("key", "cli.flag.key") },
      (o) => {
        const repo = given(o.repo);
        const requestKey = given(o.key);
        return change({
          name: "memory create",
          does: (api) => api.memory.create({ agent: o.agent, text: o.words.join(" "), ...(repo ? { repo } : {}), ...(requestKey ? { requestKey } : {}) }),
          said: memoryLine,
        });
      },
    ).pipe(
      Command.withDescription(t("cli.command.memory.create")),
      Command.withExamples([{ command: t("cli.example.memoryCreate.run"), description: t("cli.example.memoryCreate.about") }]),
    ),
    Command.make("delete", { agent: agentArg, memory: nameArg("memory", "cli.arg.memoryId") }, (o) =>
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
