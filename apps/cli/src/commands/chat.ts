import { fileURLToPath } from "node:url";

import { t } from "@vibevalley/i18n";

import { Ended, exit, Failure, type Io } from "#/base/output.ts";
import { arg, command, opt } from "#/infra/command.ts";
import { exitCodeOf } from "#/infra/spawn.ts";

/** The server's chat program, or "" when there is none to run. */
const serverChat = () => {
  try {
    return fileURLToPath(import.meta.resolve("@vibevalley/server/chat"));
  } catch {
    // The server is not installed beside this command line (a bundle without it): there is no chat to run.
    return "";
  }
};

const program = (io: Io) => io.env.VIBEVALLEY_CHAT || serverChat();

/** The server's conversation with these arguments, on this terminal. It is not stopped by the run's signal: Ctrl+C
 * reaches the conversation itself, which says when it is done. */
const converse = async (io: Io, args: readonly string[]) => {
  const chat = program(io);
  if (!chat) throw new Failure({ code: exit.other, tag: "NoChat", text: t("cli.failure.noChat") });
  let code: number;
  try {
    code = await exitCodeOf(process.execPath, [...process.execArgv, chat, ...args], { stdio: "inherit" });
  } catch (e) {
    throw new Failure({ code: exit.other, tag: "Chat", text: e instanceof Error ? e.message : String(e) });
  }
  if (code !== 0) throw new Ended(code);
};

/** The flags given, as the server's conversation reads them (apps/server src/chat/main.ts): --name value, in order. */
const passed = (flags: Readonly<Record<string, string | undefined>>) =>
  Object.entries(flags).flatMap(([name, value]) => (value !== undefined ? [`--${name}`, value] : []));

/** `chat [runtime]`: a conversation in this terminal, with VibeValley's own agent or, named, a runtime on this machine. */
export const chatCommand = command("chat", {
  about: t("cli.command.chat"),
  examples: [
    { command: "vibevalley chat", description: t("cli.example.chat.about") },
    { command: "vibevalley chat claude", description: t("cli.example.runtimeChat.about") },
  ],
  params: {
    runtime: arg.optional("runtime", "cli.arg.chatRuntime"),
    cwd: opt.text("cwd", "cli.flag.cwd"),
    model: opt.text("model", "cli.flag.model"),
    effort: opt.text("effort", "cli.flag.effort"),
    resume: opt.text("resume", "cli.flag.resume"),
    name: opt.text("name", "cli.flag.name"),
    mcp: opt.text("mcp", "cli.flag.mcp"),
    prompt: opt.textAlias("prompt", "p", "cli.flag.prompt"),
  },
  run: ({ runtime, ...flags }, ctx) => {
    const id = runtime ?? "vibevalley";
    const own = id === "vibevalley";
    // Each flag is one side's: --name and --mcp are the farm's agent's, --effort and --resume a runtime's.
    const stray = own ? (["effort", "resume"] as const) : (["name", "mcp"] as const);
    const given = stray.filter((f) => flags[f] !== undefined);
    if (given.length > 0)
      throw new Failure({
        code: exit.usage,
        tag: "InvalidValue",
        text: t("cli.failure.chatFlag", { flags: given.map((f) => `--${f}`).join(" "), runtime: id }),
      });
    return converse(
      ctx,
      own
        ? passed({ cwd: flags.cwd, name: flags.name, model: flags.model, mcp: flags.mcp, prompt: flags.prompt })
        : ["runtime", id, ...passed({ model: flags.model, effort: flags.effort, resume: flags.resume, cwd: flags.cwd, prompt: flags.prompt })],
    );
  },
});
