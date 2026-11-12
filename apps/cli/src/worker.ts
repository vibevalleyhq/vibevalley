import { DryRunFlag, FormatFlag, WorkerAccessFlag } from "#/base/format.ts";
import { exit, Failure, printFailure } from "#/base/output.ts";
import { runTree } from "#/infra/command.ts";
import { processIo } from "#/infra/process.ts";

import { workerCommand } from "./commands/worker.ts";

const io = processIo();
const code = await runTree(workerCommand, {
  args: process.argv.slice(2),
  io,
  globals: [WorkerAccessFlag, DryRunFlag, FormatFlag],
  version: "0.1.0",
  fail: printFailure,
}).then(
  (c) => c,
  (error: unknown) => {
    if (io.signal.aborted) return exit.interrupted;
    if (error instanceof Failure) {
      printFailure(io, error);
      return error.code;
    }
    return exit.usage;
  },
);
process.exit(code);
