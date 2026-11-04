// VibeValley's command line, on effect/cli, for agents first and people too. Every command is a thing to do with the
// farm, written by hand and typed (issue.ts, channel.ts…), asking the server through the typed client; what no command
// covers is `api` (api.ts; reach.ts says which). Answers are short text, or the protocol's shape with --format json; a
// failure is JSON on stderr with what to do next, and an exit code that says which kind (output.ts). `chat` is a
// conversation in the terminal: the server's program, handed this terminal (chat.ts). With no command, the help.
//
//	vpx src/main.ts issue list --waiting
//	vpx src/main.ts search 打卡
//	vpx src/main.ts chat [runtime] [--cwd DIR] [--model ID] [-p PROMPT]

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Option, Predicate, Stdio } from "effect";
import { Argument, CliError, CliOutput, Command, Flag, TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { homeOf, savedLocale } from "@vibevalley/home";
import { setLocale, t } from "@vibevalley/i18n";

import { err, exit, Failure, out, printFailure } from "./output.ts";

// The command line speaks the farm's language: the locale saved in the home's settings.json. It is set before the
// commands load, since they say their help text as they load: hence the imports below, after it.
setLocale(savedLocale(homeOf()));

const { apiCommand, DryRunFlag, FormatFlag, ServerFlag } = await import("./api.ts");
const { appCommand } = await import("./app.ts");
const { channelCommand } = await import("./channel.ts");
const { converse } = await import("./chat.ts");
const { doctorCommand } = await import("./doctor.ts");
const { guideCommand } = await import("./guide.ts");
const { issueCommand } = await import("./issue.ts");
const { keptCommands } = await import("./notes.ts");
const { pkmCommand } = await import("./pkm.ts");
const { farmPartCommands, runtimeCommand } = await import("./project.ts");
const { searchCommand } = await import("./search.ts");

const version = "0.1.0";

const text = (name: string, description: string) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));
/** The flags given, as the server's conversation reads them (apps/server src/chat.ts): --name value, in order. */
const passed = (flags: Readonly<Record<string, Option.Option<string>>>) =>
  Object.entries(flags).flatMap(([name, value]) => (Option.isSome(value) ? [`--${name}`, value.value] : []));

const prompt = text("prompt", t("cli.flag.prompt")).pipe(Flag.withAlias("p"));

/** `chat [runtime]`: a conversation in this terminal, with VibeValley's own agent or, named, a runtime on this machine.
 * Its own command, never the bare `vibevalley`: an agent that runs the command line without words gets the help, not a
 * conversation waiting on its input. */
const chatCommand = Command.make(
  "chat",
  {
    runtime: Argument.String("runtime").pipe(Argument.optional, Argument.withDescription(t("cli.arg.chatRuntime"))),
    cwd: text("cwd", t("cli.flag.cwd")),
    model: text("model", t("cli.flag.model")),
    effort: text("effort", t("cli.flag.effort")),
    resume: text("resume", t("cli.flag.resume")),
    name: text("name", t("cli.flag.name")),
    mcp: text("mcp", t("cli.flag.mcp")),
    prompt,
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

const root = Command.make("vibevalley").pipe(
  Command.withDescription(t("cli.command.root")),
  // By what a person or an agent does; what no command covers is reached through api (reach.ts says which).
  Command.withSubcommands([
    issueCommand,
    searchCommand,
    channelCommand,
    pkmCommand,
    ...farmPartCommands,
    runtimeCommand,
    ...keptCommands,
    chatCommand,
    doctorCommand,
    appCommand,
    guideCommand,
    apiCommand,
  ]),
  Command.withGlobalFlags([ServerFlag, DryRunFlag, FormatFlag]),
);

/** What the parser said was wrong, as one failure: every mistake's words, and the help of the command it was in. */
function usageOf(e: CliError.CliError): Failure {
  const path = e._tag === "ShowHelp" ? e.commandPath.slice(1) : [];
  const errors = e._tag === "ShowHelp" ? e.errors : [e];
  return new Failure({
    code: exit.usage,
    tag: errors[0]?._tag ?? e._tag,
    text: errors.map((x) => x.message).join(t("cli.and")) || e.message,
    next: [{ say: t("cli.next.help"), run: [...path, "--help"] }],
  });
}

/** Runs the command line on args and gives back its exit code. What effect/cli says itself goes through its Presenter
 * onto this run's Stdio: help and the version to stdout, help that came with a mistake to stderr before the failure, so
 * stdout stays the result. */
export const run = Effect.fn("Cli.run")(function* (args: readonly string[]) {
  const io = yield* Stdio.Stdio;
  const said = (to: typeof out, text: string) => Effect.provideService(to(text), Stdio.Stdio, io);
  const presenter: CliOutput.Presenter = {
    present: (event) =>
      Effect.gen(function* () {
        const formatter = CliOutput.defaultFormatter({ colors: (yield* TerminalCapabilities.TerminalCapabilities).canColor });
        switch (event._tag) {
          case "Help":
            // Asked for (--help) to stdout; shown because of a mistake, to stderr with it.
            return yield* said(event.reason === "Requested" ? out : err, formatter.formatHelpDoc(event.helpDoc).replace(/\n+$/u, ""));
          case "InvalidInvocation":
            return yield* said(err, formatter.formatHelpDoc(event.helpDoc).replace(/\n+$/u, ""));
          case "Version":
            return yield* said(out, formatter.formatVersion(event.name, event.version));
        }
      }),
  };
  // Run bare, it was asked what it can do: the help, on stdout as with --help.
  return yield* Command.runWith(root, { version, renderErrors: false })(args.length === 0 ? ["--help"] : args).pipe(
    Effect.provide(CliOutput.layerPresenter(presenter)),
    Effect.as(exit.ok as number),
    Effect.catch((e) => {
      if (CliError.isCliError(e) && e._tag === "ShowHelp" && e.errors.length === 0) return Effect.succeed(exit.ok);
      // The conversation said what it had to on the terminal: only its code is left.
      if (Predicate.isTagged(e, "Ended")) return Effect.succeed(e.code);
      const f = Predicate.isTagged(e, "Failure") ? e : CliError.isCliError(e) ? usageOf(e) : new Failure({ code: exit.other, tag: "Error", text: String(e) });
      return Effect.as(printFailure(f), f.code);
    }),
  );
});

/** The process ends with the command's code; Ctrl+C interrupts it, and its streams and requests are let go of first. */
const codeOf = (end: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(end) ? (typeof end.value === "number" ? end.value : exit.ok) : Cause.hasInterruptsOnly(end.cause) ? exit.interrupted : exit.other;

// Not every loader sets import.meta.main: the script run is then told by its path.
if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  run(process.argv.slice(2)).pipe(
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: (end) => process.exit(codeOf(end)) }),
  );
}
