// The message box's slash commands (docs/style/design.md, 输入框): / at the start of the box offers them as @ offers
// names, and a line that is one of them runs it instead of being said. A command is an endpoint of the API (api.ts),
// not a second way of doing things: what it may do and what it refuses is the server's.

import { t } from "@vibevalley/i18n";
import type { Channel } from "@vibevalley/protocol";
import { api } from "@/base/api";
import type { Nameable } from "./rules";

export const CommandNames = ["issue", "remember", "stop", "dm"] as const;
export type CommandName = (typeof CommandNames)[number];

/** Where a command runs: the place the box writes to, and the orchestrator that looks after it. */
export interface CommandPlace {
  readonly channel: Channel | undefined;
  readonly orchestrator: string;
}

/** What came of a command: words to show, or a place to open. */
export type CommandDone = { readonly say: string } | { readonly open: string };

/** Whether a command needs words after it (a title, a note, a profile). */
const needsText: Record<CommandName, boolean> = { issue: true, remember: true, stop: false, dm: true };

const run: Record<CommandName, (text: string, at: CommandPlace) => Promise<CommandDone>> = {
  issue: async (title, at) => {
    const made = await api.issue.create({ title, ...(at.channel?.project ? { project: at.channel.project } : {}) });
    return { say: t("web.channel.commands.done.issue", { n: made.number }) };
  },
  remember: async (text, at) => {
    await api.memory.create({ agent: at.orchestrator, text });
    return { say: t("web.channel.commands.done.remember") };
  },
  stop: async (_text, at) => {
    await api.orchestrator.stop({ agent: at.orchestrator });
    return { say: t("web.channel.commands.done.stop") };
  },
  dm: async (who) => ({ open: `/chat/${await api.channel.direct.create({ agent: who })}` }),
};

/** The commands as the menu offers them, like names: /issue, /stop… */
export const commandNameables = (): Nameable[] =>
  CommandNames.map((name) => ({ token: `/${name}`, name: t(`web.channel.commands.${name}.name`), note: t(`web.channel.commands.${name}.note`) }));

/** The command being typed: / first in the box, the caret still in its word. */
export function typedCommand(text: string, caret: number) {
  if (!text.startsWith("/") || caret < 1) return undefined;
  const word = text.slice(1, caret);
  return /^[a-z]*$/.test(word) ? { start: 0, query: word } : undefined;
}

/** A line that is a command, with the words after it; any other line, /usr/bin too, is said as it is. */
export function commandOf(line: string): { readonly name: CommandName; readonly text: string } | undefined {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  const name = CommandNames.find((n) => n === m?.[1]);
  return name ? { name, text: (m?.[2] ?? "").trim() } : undefined;
}

/** Runs a command; one that needs words and has none is refused here, before the server is asked. */
export async function runCommand(command: { readonly name: CommandName; readonly text: string }, at: CommandPlace): Promise<CommandDone> {
  if (needsText[command.name] && !command.text) throw new Error(t(`web.channel.commands.${command.name}.needs`));
  return run[command.name](command.text, at);
}
