import { fileURLToPath } from "node:url";

import { Config, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";

import { exit, Failure } from "./output.ts";

/** The conversation ended with this exit code; it has said what it had to on the terminal itself. */
class Ended extends Schema.TaggedError<Ended, { readonly brand: unique symbol }>()("Ended", { code: Schema.Finite }) {}

/** The server's chat program, or "" when there is none to run. */
const serverChat = () => {
  try {
    return fileURLToPath(import.meta.resolve("@vibevalley/server/chat"));
  } catch {
    return "";
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

const text = (name: string, description: string) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));
/** The flags given, as the server's conversation reads them (apps/server src/chat.ts): --name value, in order. */
const passed = (flags: Readonly<Record<string, Option.Option<string>>>) =>
  Object.entries(flags).flatMap(([name, value]) => (Option.isSome(value) ? [`--${name}`, value.value] : []));

/** `chat [runtime]`: a conversation in this terminal, with VibeValley's own agent or, named, a runtime on this machine. */
export const chatCommand = Command.make(
  "chat",
  {
    runtime: Argument.String("runtime").pipe(Argument.optional, Argument.withDescription(t("cli.arg.chatRuntime"))),
    cwd: text("cwd", t("cli.flag.cwd")),
    model: text("model", t("cli.flag.model")),
    effort: text("effort", t("cli.flag.effort")),
    resume: text("resume", t("cli.flag.resume")),
    name: text("name", t("cli.flag.name")),
    mcp: text("mcp", t("cli.flag.mcp")),
    prompt: text("prompt", t("cli.flag.prompt")).pipe(Flag.withAlias("p")),
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
