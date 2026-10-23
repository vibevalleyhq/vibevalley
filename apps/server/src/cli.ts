// VibeValley's command line, on effect/cli. With no command: VibeValley's own agent in a terminal (cli/chat.ts).
// `runtime chat <runtime>` talks to another runtime the same way. Every other command is one of the endpoints
// (cli/api.ts), called over HTTP: its answer is JSON on stdout; a failure is JSON on stderr with what to do next, and an
// exit code that says which kind (cli/output.ts).
//
//	node --import tsx src/cli.ts [--cwd DIR] [--name NAME] [--model ID] [--mcp FILE] [-p PROMPT]
//	node --import tsx src/cli.ts runtime chat claude
//	node --import tsx src/cli.ts issue list

import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { eventsCommand, groupCommands, issueRunCommand, ServerFlag, stateCommand } from "./cli/api.ts";
import { ownChat, runtimeChat } from "./cli/chat.ts";
import { exit, Failure, type Io, printFailure } from "./cli/output.ts";

const version = "0.1.0";

const text = (name: string, description: string) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));
const some = (o: Option.Option<string>) => Option.getOrUndefined(o);
const asked = (p: Option.Option<string>) => (Option.isSome(p) ? { p: p.value } : {});
const chatFailed = (e: unknown) => new Failure({ code: exit.other, tag: "Chat", text: e instanceof Error ? e.message : String(e) });

const prompt = text("prompt", "问一句就走，不进对话").pipe(Flag.withAlias("p"));

const runtimeChatCommand = Command.make(
  "chat",
  {
    runtime: Argument.String("runtime").pipe(Argument.withDescription("claude、codex、kimi、pi……；vibevalley 是自己的 agent")),
    model: text("model", "模型"),
    effort: text("effort", "思考的力度"),
    resume: text("resume", "接着这个会话"),
    cwd: text("cwd", "在哪个文件夹；不填是当前的"),
    prompt,
  },
  (o) =>
    Effect.tryPromise({
      try: () =>
        runtimeChat(o.runtime, {
          ...(Option.isSome(o.model) ? { model: o.model.value } : {}),
          ...(Option.isSome(o.effort) ? { effort: o.effort.value } : {}),
          ...(Option.isSome(o.resume) ? { resume: o.resume.value } : {}),
          ...(Option.isSome(o.cwd) ? { cwd: o.cwd.value } : {}),
          ...asked(o.prompt),
        }),
      catch: chatFailed,
    }),
).pipe(Command.withDescription("和一个农机直接聊，不经过 VibeValley：不记轨迹和花费"));

const root = (io: Io) =>
  Command.make(
    "vibevalley",
    {
      cwd: text("cwd", "自己的 agent 在哪个文件夹干活；不填是当前的"),
      name: text("name", "自己的 agent 的名字（家目录 ~/.vibevalley/agent/<名字>）"),
      model: text("model", "模型；不填用配置里的"),
      mcp: text("mcp", "MCP 配置文件；不填用家目录里的 mcp.json"),
      prompt,
    },
    (o) =>
      Effect.tryPromise({
        try: () =>
          ownChat({ cwd: some(o.cwd) ?? "", name: some(o.name) ?? "vibevalley", model: some(o.model) ?? "", mcp: some(o.mcp) ?? "", ...asked(o.prompt) }),
        catch: chatFailed,
      }),
  ).pipe(
    Command.withDescription("不带命令是和 VibeValley 自己的 agent 聊；别的命令是调 VibeValley 的接口，答复是 JSON"),
    Command.withSubcommands([
      ...groupCommands(io, { issue: [issueRunCommand(io)], runtime: [runtimeChatCommand] }),
      stateCommand(io),
      eventsCommand(io),
    ] as never),
    Command.withGlobalFlags([ServerFlag]),
  );

/** What the parser said was wrong, as one failure: every mistake's words, and the help of the command it was in. */
function usageOf(e: CliError.CliError): Failure {
  const path = e._tag === "ShowHelp" ? e.commandPath.slice(1) : [];
  const errors = e._tag === "ShowHelp" ? e.errors : [e];
  return new Failure({
    code: exit.usage,
    tag: errors[0]?._tag ?? e._tag,
    text: errors.map((x) => x.message).join("；") || e.message,
    next: [{ say: "看这条命令怎么写", run: [...path, "--help"] }],
  });
}

/** Runs the command line on args and gives back its exit code. Whatever effect/cli prints (help, version, completions)
 * is held and goes to stdout when asked for, to stderr when it came with a mistake: stdout stays the result. */
export function run(args: readonly string[], io: Io): Effect.Effect<number> {
  const held: string[] = [];
  const hold = (...a: unknown[]) => void held.push(a.map(String).join(" "));
  const console_ = Object.assign(Object.create(console) as Console.Console, { log: hold, error: hold, info: hold, warn: hold });
  const flush = (to: (s: string) => void) => {
    if (held.length > 0) to(held.join("\n").replace(/\n+$/, ""));
    held.length = 0;
  };
  return Command.runWith(root(io), { version, renderErrors: false })(args).pipe(
    Effect.provideService(Console.Console, console_),
    Effect.provide(NodeServices.layer),
    Effect.map(() => {
      flush(io.out);
      return exit.ok as number;
    }),
    Effect.catch((e: unknown) =>
      Effect.sync(() => {
        if (CliError.isCliError(e) && e._tag === "ShowHelp" && e.errors.length === 0) {
          flush(io.out);
          return exit.ok;
        }
        flush(io.err);
        const f = e instanceof Failure ? e : CliError.isCliError(e) ? usageOf(e) : new Failure({ code: exit.other, tag: "Error", text: String(e) });
        printFailure(io, f);
        return f.code;
      }),
    ),
  );
}

const processIo: Io = {
  out: (s) => void process.stdout.write(s + "\n"),
  err: (s) => void process.stderr.write(s + "\n"),
  tty: process.stdout.isTTY === true,
  stdin: () => new Response(process.stdin as never).text(),
  env: process.env,
};

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  Effect.runPromise(run(process.argv.slice(2), processIo)).then((code) => process.exit(code));
}
