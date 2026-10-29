import { t } from "@vibevalley/i18n";
// VibeValley's command line, on effect/cli. With no command: VibeValley's own agent in a terminal (cli/chat.ts).
// `runtime chat <runtime>` talks to another runtime the same way. Every other command is one of the endpoints
// (cli/api.ts), called over HTTP: its answer is JSON on stdout; a failure is JSON on stderr with what to do next, and an
// exit code that says which kind (cli/output.ts).
//
//	node --import tsx src/cli.ts [--cwd DIR] [--name NAME] [--model ID] [--mcp FILE] [-p PROMPT]
//	node --import tsx src/cli.ts runtime chat claude
//	node --import tsx src/cli.ts issue list

import { messageOf } from "./errors.ts";
import "./cli/locale.ts";

import { Cause, Console, Effect, Exit, Fiber, Option, type Stdio } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { DryRunFlag, eventsCommand, groupCommands, issueWorkCommand, ServerFlag, stateCommand } from "./cli/api.ts";
import { ownChat, runtimeChat } from "./cli/chat.ts";
import { err, exit, Failure, out, printFailure } from "./cli/output.ts";

const version = "0.1.0";

const text = (name: string, description: string) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));
const some = (o: Option.Option<string>) => Option.getOrUndefined(o);
const asked = (p: Option.Option<string>) => (Option.isSome(p) ? { p: p.value } : {});
/** A conversation in the terminal. It takes Ctrl+C itself (stop the turn, again to quit), so the signal that interrupts
 * any other command must not end it: it runs uninterruptible and ends when the conversation does. */
const chat = (talk: Effect.Effect<void, unknown>) =>
  // Detached and joined uninterruptibly: the conversation itself stays interruptible inside (a turn Ctrl+C stops).
  Effect.uninterruptible(Effect.flatMap(Effect.forkDetach(talk), Fiber.join)).pipe(
    Effect.mapError((e) => new Failure({ code: exit.other, tag: "Chat", text: typeof e === "string" ? e : messageOf(e) })),
  );

const prompt = text("prompt", t("server.cli.flag.prompt")).pipe(Flag.withAlias("p"));

const runtimeChatCommand = Command.make(
  "chat",
  {
    runtime: Argument.String("runtime").pipe(Argument.withDescription(t("server.cli.flag.runtime"))),
    model: text("model", t("server.cli.flag.model")),
    effort: text("effort", t("server.cli.flag.effort")),
    resume: text("resume", t("server.cli.flag.resume")),
    cwd: text("cwd", t("server.cli.flag.cwd")),
    prompt,
  },
  (o) =>
    chat(
      runtimeChat(o.runtime, {
        ...(Option.isSome(o.model) ? { model: o.model.value } : {}),
        ...(Option.isSome(o.effort) ? { effort: o.effort.value } : {}),
        ...(Option.isSome(o.resume) ? { resume: o.resume.value } : {}),
        ...(Option.isSome(o.cwd) ? { cwd: o.cwd.value } : {}),
        ...asked(o.prompt),
      }),
    ),
).pipe(Command.withDescription(t("server.cli.command.runtimeChat")));

const root = Command.make(
  "vibevalley",
  {
    cwd: text("cwd", t("server.cli.flag.ownCwd")),
    name: text("name", t("server.cli.flag.name")),
    model: text("model", t("server.cli.flag.ownModel")),
    mcp: text("mcp", t("server.cli.flag.mcp")),
    prompt,
  },
  (o) => chat(ownChat({ cwd: some(o.cwd) ?? "", name: some(o.name) ?? "vibevalley", model: some(o.model) ?? "", mcp: some(o.mcp) ?? "", ...asked(o.prompt) })),
).pipe(
  Command.withDescription(t("server.cli.command.root")),
  Command.withSubcommands([...groupCommands({ issue: [issueWorkCommand], runtime: [runtimeChatCommand] }), stateCommand, eventsCommand] as never),
  Command.withGlobalFlags([ServerFlag, DryRunFlag]),
);

/** What the parser said was wrong, as one failure: every mistake's words, and the help of the command it was in. */
function usageOf(e: CliError.CliError): Failure {
  const path = e._tag === "ShowHelp" ? e.commandPath.slice(1) : [];
  const errors = e._tag === "ShowHelp" ? e.errors : [e];
  return new Failure({
    code: exit.usage,
    tag: errors[0]?._tag ?? e._tag,
    text: errors.map((x) => x.message).join(t("server.cli.and")) || e.message,
    next: [{ say: t("server.cli.next.help"), run: [...path, "--help"] }],
  });
}

/** Runs the command line on args and gives back its exit code. Whatever effect/cli prints (help, version, completions)
 * is held and goes to stdout when asked for, to stderr when it came with a mistake: stdout stays the result. */
export const run = Effect.fn("Cli.run")(function* (args: readonly string[]) {
  const held: string[] = [];
  const hold = (...a: unknown[]) => void held.push(a.map(String).join(" "));
  const console_ = Object.assign(Object.create(console) as Console.Console, { log: hold, error: hold, info: hold, warn: hold });
  const flush = (to: (s: string) => Effect.Effect<void, never, Stdio.Stdio>) =>
    Effect.suspend(() => {
      const text = held.join("\n").replace(/\n+$/, "");
      held.length = 0;
      return text ? to(text) : Effect.void;
    });
  return yield* Command.runWith(root, { version, renderErrors: false })(args).pipe(
    Effect.provideService(Console.Console, console_),
    Effect.andThen(flush(out)),
    Effect.as(exit.ok as number),
    Effect.catch((e: unknown) => {
      if (CliError.isCliError(e) && e._tag === "ShowHelp" && e.errors.length === 0) return Effect.as(flush(out), exit.ok as number);
      const f = e instanceof Failure ? e : CliError.isCliError(e) ? usageOf(e) : new Failure({ code: exit.other, tag: "Error", text: String(e) });
      return flush(err).pipe(Effect.andThen(printFailure(f)), Effect.as(f.code));
    }),
  );
});

/** The process ends with the command's code; Ctrl+C interrupts it, and its streams and requests are let go of first. */
const codeOf = (end: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(end) ? (end.value as number) : Cause.hasInterruptsOnly(end.cause) ? exit.interrupted : exit.other;

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  run(process.argv.slice(2)).pipe(
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: (end) => process.exit(codeOf(end)) }),
  );
}
