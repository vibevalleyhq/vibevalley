import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Schema, Stdio } from "effect";
import { CliError, CliOutput, Command, TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";

import { agentCommand } from "./commands/agent.ts";
import { appCommand } from "./commands/app.ts";
import { artifactCommand } from "./commands/artifact.ts";
import { channelCommand } from "./commands/channel.ts";
import { chatCommand } from "./commands/chat.ts";
import { cronCommand } from "./commands/cron.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { issueCommand } from "./commands/issue.ts";
import { memoryCommand } from "./commands/memory.ts";
import { pkmCommand } from "./commands/pkm.ts";
import { repoCommand } from "./commands/repo.ts";
import { runtimeCommand } from "./commands/runtime.ts";
import { sessionCommand } from "./commands/session.ts";
import { WorkerAccessFlag, workerCommand } from "./commands/worker.ts";
import { DryRunFlag, FormatFlag, ServerFlag } from "./farm.ts";
import { Ended, err, exit, Failure, out, printFailure } from "./output.ts";

const version = "0.1.0";

const root = Command.make("vibevalley").pipe(
  Command.withDescription(t("cli.command.root")),
  Command.withSubcommands([
    workerCommand,
    issueCommand,
    pkmCommand,
    channelCommand,
    repoCommand,
    agentCommand,
    sessionCommand,
    runtimeCommand,
    memoryCommand,
    cronCommand,
    artifactCommand,
    chatCommand,
    doctorCommand,
    appCommand,
  ]),
  Command.withGlobalFlags([ServerFlag, DryRunFlag, FormatFlag, WorkerAccessFlag]),
);

/** What the parser said was wrong, as one failure: every mistake's words, and the help of the command it was in. */
function usageOf(e: CliError.CliError): Failure {
  const path = e._tag === "ShowHelp" ? e.commandPath.slice(1) : [];
  const errors = e._tag === "ShowHelp" ? e.errors : [e];
  return Failure.make({
    code: exit.usage,
    tag: errors[0]?._tag ?? e._tag,
    text: errors.map((x) => x.message).join(t("cli.and")) || e.message,
    next: [{ say: t("cli.next.help"), run: [...path, "--help"] }],
  });
}

/** Runs the command line on args and gives back its exit code. */
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
    Effect.as<number>(exit.ok),
    Effect.catch((e) => {
      if (CliError.isCliError(e) && e._tag === "ShowHelp" && e.errors.length === 0) return Effect.succeed(exit.ok);
      // The conversation said what it had to on the terminal: only its code is left.
      if (Schema.is(Ended)(e)) return Effect.succeed(e.code);
      const f = Schema.is(Failure)(e) ? e : CliError.isCliError(e) ? usageOf(e) : Failure.make({ code: exit.other, tag: "Error", text: String(e) });
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
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: (end) => end.pipe(codeOf, (code) => process.exit(code)) }),
  );
}
