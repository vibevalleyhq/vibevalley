// VibeValley's command line, on effect/cli, for agents first and people too. With no command: VibeValley's own agent in
// a terminal (cli/chat.ts). Every other command is a thing to do with the farm, written by hand and typed (cli/issue.ts,
// cli/channel.ts…), asking the server through the typed client; what no command covers is `api` (cli/api.ts, cli/reach.ts
// says which). Answers are short text, or the protocol's shape with --format json; a failure is JSON on stderr with what
// to do next, and an exit code that says which kind (cli/output.ts).
//
//	vpx src/cli.ts [--cwd DIR] [--name NAME] [--model ID] [--mcp FILE] [-p PROMPT]
//	vpx src/cli.ts runtime chat claude
//	vpx src/cli.ts issue list --waiting

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Fiber, Option, Predicate, Stdio } from "effect";
import { Argument, CliError, CliOutput, Command, Flag, TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { homeOf, savedLocale } from "@vibevalley/home";
import { setLocale, t } from "@vibevalley/i18n";

import { err, exit, Failure, out, printFailure } from "./cli/output.ts";
import { messageOf } from "./errors.ts";

// The command line speaks the farm's language: the locale saved in the home's settings.json. It is set before the
// commands load, since they say their help text as they load: hence the imports below, after it.
setLocale(savedLocale(homeOf()));

const { apiCommand, DryRunFlag, FormatFlag, ServerFlag } = await import("./cli/api.ts");
const { appCommand } = await import("./cli/app.ts");
const { channelCommand } = await import("./cli/channel.ts");
const { ownChat, runtimeChat } = await import("./cli/chat.ts");
const { doctorCommand } = await import("./cli/doctor.ts");
const { guideCommand } = await import("./cli/guide.ts");
const { issueCommand } = await import("./cli/issue.ts");
const { keptCommands } = await import("./cli/notes.ts");
const { pkmCommand } = await import("./cli/pkm.ts");
const { farmPartCommands, runtimeCommands } = await import("./cli/project.ts");

const version = "0.1.0";

const text = (name: string, description: string) => Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));
const some = (o: Option.Option<string>) => Option.getOrUndefined(o);
const asked = (p: Option.Option<string>) => (Option.isSome(p) ? { p: p.value } : {});
/** A conversation in the terminal. It takes Ctrl+C itself (stop the turn, again to quit), so the signal that interrupts
 * any other command must not end it: it runs uninterruptible and ends when the conversation does. */
const chat = <E>(talk: Effect.Effect<void, E>) =>
  // Detached and joined uninterruptibly: the conversation itself stays interruptible inside (a turn Ctrl+C stops). The
  // command's own end is the conversation's, so nothing outlives it.
  // oxlint-disable-next-line vibevalley/scoped-fibers -- a terminal conversation the process signal must not cut; joined at once
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
).pipe(
  Command.withDescription(t("server.cli.command.runtimeChat")),
  Command.withExamples([{ command: "vibevalley runtime chat claude", description: t("server.cli.example.runtimeChat.about") }]),
);

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
  // By what a person or an agent does; what no command covers is reached through api (cli/reach.ts says which).
  Command.withSubcommands([
    issueCommand,
    channelCommand,
    pkmCommand,
    ...farmPartCommands,
    Command.make("runtime").pipe(
      Command.withSubcommands([...runtimeCommands, runtimeChatCommand]),
      Command.withDescription(t("server.cli.group.runtime.about")),
    ),
    ...keptCommands,
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
    text: errors.map((x) => x.message).join(t("server.cli.and")) || e.message,
    next: [{ say: t("server.cli.next.help"), run: [...path, "--help"] }],
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
  return yield* Command.runWith(root, { version, renderErrors: false })(args).pipe(
    Effect.provide(CliOutput.layerPresenter(presenter)),
    Effect.as(exit.ok as number),
    Effect.catch((e) => {
      if (CliError.isCliError(e) && e._tag === "ShowHelp" && e.errors.length === 0) return Effect.succeed(exit.ok);
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
