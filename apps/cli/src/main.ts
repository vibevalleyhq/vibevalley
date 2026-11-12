import { t } from "@vibevalley/i18n";

import { DryRunFlag, FormatFlag, ServerFlag, WorkerAccessFlag } from "#/base/format.ts";
import { Ended, exit, Failure, type Io, printFailure } from "#/base/output.ts";
import { group, runTree } from "#/infra/command.ts";
import { processIo } from "#/infra/process.ts";

import { agentCommand } from "./commands/agent.ts";
import { appCommand } from "./commands/app.ts";
import { artifactCommand } from "./commands/artifact.ts";
import { authCommand } from "./commands/auth.ts";
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
import { workerCommand } from "./commands/worker.ts";

const version = "0.1.0";

const root = group("vibevalley", t("cli.command.root"), [
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
  authCommand,
]);

/** Runs the command line on args and gives back its exit code. */
export async function run(args: readonly string[], io: Io): Promise<number> {
  try {
    // Run bare, it was asked what it can do: the help, on stdout as with --help.
    return await runTree(root, {
      args: args.length === 0 ? ["--help"] : args,
      io,
      globals: [ServerFlag, DryRunFlag, FormatFlag, WorkerAccessFlag],
      version: `vibevalley v${version}`,
      fail: printFailure,
    });
  } catch (e) {
    // The conversation said what it had to on the terminal: only its code is left.
    if (e instanceof Ended) return e.code;
    if (io.signal.aborted) return exit.interrupted;
    const f = e instanceof Failure ? e : new Failure({ code: exit.other, tag: "Error", text: e instanceof Error ? e.message : String(e) });
    printFailure(io, f);
    return f.code;
  }
}

// Not every loader sets import.meta.main: the script run is then told by its path.
if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  // The process ends with the command's code; Ctrl+C aborts it, and its streams and requests are let go of first.
  process.exit(await run(process.argv.slice(2), processIo()));
}
