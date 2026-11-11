import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Schema } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { DryRunFlag, FormatFlag } from "#/base/format.ts";
import { exit, Failure, printFailure } from "#/base/output.ts";

import { WorkerAccessFlag, workerCommand } from "./commands/worker.ts";

const root = workerCommand.pipe(Command.withGlobalFlags([WorkerAccessFlag, DryRunFlag, FormatFlag]));
Command.runWith(root, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.as<number>(exit.ok),
  Effect.catch((error) => (Schema.is(Failure)(error) ? Effect.as(printFailure(error), error.code) : Effect.succeed(exit.usage))),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    teardown: (result) =>
      process.exit(
        Exit.isSuccess(result)
          ? typeof result.value === "number"
            ? result.value
            : exit.ok
          : Cause.hasInterruptsOnly(result.cause)
            ? exit.interrupted
            : exit.other,
      ),
  }),
);
