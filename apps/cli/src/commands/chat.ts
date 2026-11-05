import { fileURLToPath } from "node:url";

import { Config, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";

import { optionalText } from "#/farm.ts";
import { Ended, exit, Failure } from "#/output.ts";

/** The server's chat program, or "" when there is none to run. */
const serverChat = () => {
  try {
    return fileURLToPath(import.meta.resolve("@vibevalley/server/chat"));
  } catch (e) {
    return e ? "" : "";
  }
};

const program = Config.String("VIBEVALLEY_CHAT").pipe(
  Config.withDefault(""),
  Config.map((given) => given || serverChat()),
);

/** The server's conversation with these arguments, on this terminal. */
const converse = (args: readonly string[]) =>
  Effect.gen(function* () {
    const chat = yield* program;
    if (!chat) return yield* new Failure({ code: exit.other, tag: "NoChat", text: t("cli.failure.noChat") });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner
      .exitCode(ChildProcess.make(process.execPath, [...process.execArgv, chat, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Chat", text: e.message })));
    if (code !== 0) return yield* new Ended({ code });
  }).pipe(Effect.uninterruptible);

/** The flags given, as the server's conversation reads them (apps/server src/chat/main.ts): --name value, in order. */
const passed = (flags: Readonly<Record<string, Option.Option<string>>>) =>
  Object.entries(flags).flatMap(([name, value]) => (Option.isSome(value) ? [`--${name}`, value.value] : []));

/** `chat [runtime]`: a conversation in this terminal, with VibeValley's own agent or, named, a runtime on this machine. */
export const chatCommand = Command.make(
  "chat",
  {
    runtime: Argument.String("runtime").pipe(Argument.optional, Argument.withDescription(t("cli.arg.chatRuntime"))),
    cwd: optionalText("cwd", "cli.flag.cwd"),
    model: optionalText("model", "cli.flag.model"),
    effort: optionalText("effort", "cli.flag.effort"),
    resume: optionalText("resume", "cli.flag.resume"),
    name: optionalText("name", "cli.flag.name"),
    mcp: optionalText("mcp", "cli.flag.mcp"),
    prompt: optionalText("prompt", "cli.flag.prompt").pipe(Flag.withAlias("p")),
  },
  ({ runtime, ...flags }) => {
    const id = Option.getOrElse(runtime, () => "vibevalley");
    const own = id === "vibevalley";
    // Each flag is one side's: --name and --mcp are the farm's agent's, --effort and --resume a runtime's.
    const stray = own ? (["effort", "resume"] as const) : (["name", "mcp"] as const);
    const given = stray.filter((f) => Option.isSome(flags[f]));
    if (given.length > 0)
      return Effect.fail(
        new Failure({ code: exit.usage, tag: "InvalidValue", text: t("cli.failure.chatFlag", { flags: given.map((f) => `--${f}`).join(" "), runtime: id }) }),
      );
    return converse(
      own
        ? passed({ cwd: flags.cwd, name: flags.name, model: flags.model, mcp: flags.mcp, prompt: flags.prompt })
        : ["runtime", id, ...passed({ model: flags.model, effort: flags.effort, resume: flags.resume, cwd: flags.cwd, prompt: flags.prompt })],
    );
  },
).pipe(
  Command.withDescription(t("cli.command.chat")),
  Command.withExamples([
    { command: "vibevalley chat", description: t("cli.example.chat.about") },
    { command: "vibevalley chat claude", description: t("cli.example.runtimeChat.about") },
  ]),
);
